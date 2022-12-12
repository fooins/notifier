/* eslint-disable no-continue */
/* eslint-disable no-await-in-loop */
const config = require('config');
const uuid = require('uuid');
const CryptoJS = require('crypto-js');
const moment = require('moment');
const axios = require('axios');
const dao = require('./dao');
const { aesDecrypt } = require('./libraries/crypto');
const { sleep, error500 } = require('./libraries/utils');
const { getRedis } = require('./libraries/redis');
const { handleError } = require('./libraries/error-handling');
const logger = require('./libraries/logger')('service', {
  level: 'info',
});

// 消费者名称
const consumer = uuid.v4();

/**
 * 创建消费者组
 */
const createGroup = async () => {
  try {
    await getRedis().xgroup(
      'CREATE',
      `insbiz:${config.get('queue.key')}`, // 队列名（这里需要手动加前缀）
      config.get('queue.group'), // 消费者组名
      '0-0', // 0-0 表示从头开始消费
      'MKSTREAM', // 队列不存在时创建队列
    );
  } catch (error) {
    // 已存在则忽略
  }
};

/**
 * 读取队列消息
 * @returns {array}
 */
const readMsgs = async () => {
  // 读取消息
  const rst = await getRedis().xreadgroup(
    'GROUP',
    config.get('queue.group'), // 消费者组名
    consumer, // 消费者名称
    'COUNT',
    config.get('queue.count'), // 获取的条数
    'STREAMS',
    config.get('queue.key'), // 队列名
    '>', // > 表示接收从未传递给任何其他消费者的消息
  );
  if (!rst) return [];
  logger.info(rst);

  // 数据格式校验
  //
  if (!Array.isArray(rst) || !Array.isArray(rst[0])) {
    throw error500('队列数据有误');
  }
  const [[key, infos]] = rst;
  if (key !== `insbiz:${config.get('queue.key')}`) {
    throw error500('队列数据归属有误');
  }

  // 解析数据
  const taskIds = [];
  for (let i = 0; i < infos.length; i += 1) {
    const [id, content] = infos[i] || [];
    if (!id) throw error500('消息ID有误');
    if (!Array.isArray(content)) throw error500('消息内容有误');

    const [field, value] = content;
    if (field !== 'tid') throw error500('字段名有误');
    if (!value) throw error500('tid值有误');

    taskIds.push(value);
  }

  return taskIds;
};

/**
 * 查询任务
 * @param {array} taskIds 任务ID列表
 * @returns {array}
 */
const queryTasks = async (taskIds) => {
  // 查询任务
  const rsts = await dao.queryTasks(taskIds);

  // 任务检查
  const tasks = [];
  for (let i = 0; i < taskIds.length; i += 1) {
    const taskId = taskIds[i];
    const task = rsts.find((t) => `${t.id}` === `${taskId}`);

    if (!task) {
      logger.error(`任务不存在（taskId=${taskId}）`);
      continue;
    }

    if (!['handing', 'retry'].includes(task.status)) {
      logger.error(`任务不是 handing 或 retry 状态（taskId=${taskId}）`);
      continue;
    }

    tasks.push(task);
  }
  if (tasks.length <= 0) return [];

  return tasks;
};

/**
 * 获取查询参数字符串
 * @param {object} query 查询参数对象
 * @returns {string} 查询参数字符串
 */
const getQueryStr = (query) => {
  const keys = Object.keys(query);
  keys.sort();

  const pairs = [];
  keys.forEach((key) => {
    pairs.push(`${key}=${query[key]}`);
  });

  return pairs.join('&');
};

/**
 * 执行通知
 * @param {object} task 通知任务
 */
const notify = async (task) => {
  const { Producer: producer, Secrets } = task;
  const [secret] = Secrets;

  // 数据校验
  if (!producer || !producer.notifyUrl) throw error500('渠道通知地址有误');
  if (!secret) throw error500('渠道密钥有误');

  // 更新任务
  await dao.updateNotifyTask(
    {
      handledAt: Date.now(),
      retries: !task.retryAt ? 0 : task.retries + 1,
    },
    { id: task.id },
  );

  // 解析通知地址
  const url = new URL(producer.notifyUrl);

  // 生成签名
  const timestamp = Math.floor(Date.now() / 1000); // 当前时间戳（秒级）
  const path = url.pathname; // 请求路径
  const queryStr = getQueryStr(url.searchParams); // 查询参数字符串
  const rawBody = JSON.stringify(task.dataParsed.body); // 原始请求体
  const signature = CryptoJS.enc.Base64.stringify(
    CryptoJS.HmacSHA1(
      `${secret.secretId}${timestamp}${path}${queryStr}${rawBody}`,
      aesDecrypt(secret.secretKey),
    ),
  );

  // 发起请求
  await axios
    .request({
      url: producer.notifyUrl,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `SecretId=${secret.secretId}, Timestamp=${timestamp}, Signature=${signature}`,
      },
      data: rawBody,
    })
    .catch((error) => {
      // eslint-disable-next-line no-param-reassign
      error.retry = true;
      throw error;
    });

  // 更新任务
  await dao.updateNotifyTask(
    {
      status: 'succeed',
      finishedAt: Date.now(),
    },
    { id: task.id },
  );
};

/**
 * 执行处理
 * @param {object} task 任务
 */
const handler = async (task) => {
  try {
    await notify(task);
  } catch (error) {
    const data = {
      status: 'failure',
      finishedAt: Date.now(),
      failureReasons: JSON.stringify({
        message: error.message,
        stack: error.stack,
      }),
      retryAt: null,
    };

    if (error.retry) {
      // 重试间隔
      const retryInterval = {
        0: { amount: 15, unit: 'seconds' },
        1: { amount: 30, unit: 'seconds' },
        2: { amount: 3, unit: 'minutes' },
        3: { amount: 10, unit: 'minutes' },
        4: { amount: 20, unit: 'minutes' },
        5: { amount: 30, unit: 'minutes' },
        6: { amount: 60, unit: 'minutes' },
        7: { amount: 3, unit: 'hours' },
        8: { amount: 6, unit: 'hours' },
        9: { amount: 24, unit: 'hours' },
      };

      data.status = task.retries > 9 ? 'failure' : 'retry';
      data.retryAt = retryInterval[task.retries]
        ? moment().add(
            retryInterval[task.retries].amount,
            retryInterval[task.retries].unit,
          )
        : null;
    }

    await dao.updateNotifyTask(data, { id: task.id });
  }
};

/**
 * 启动服务
 */
const startService = async () => {
  // 创建消费者组
  await createGroup();

  // 轮询
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // 停顿
      await sleep(2000);

      // 读取队列消息
      const taskIds = await readMsgs();

      // 查询任务数据
      const tasks = await queryTasks(taskIds);

      // 执行处理
      await Promise.all(tasks.map((task) => handler(task)));
    } catch (error) {
      handleError(error);
    }
  }
};

module.exports = {
  startService,
};
