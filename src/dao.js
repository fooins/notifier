const { Op } = require('sequelize');
const { error500 } = require('./libraries/utils');
const {
  getNotifyTaskModel,
  getSecretModel,
  getProducerModel,
} = require('./models');

/**
 * 查询待处理的通知任务
 * @param {array} taskIds 任务ID列表
 * @returns {array} 待处理的通知任务
 */
const queryTasks = async (taskIds) => {
  const NotifyTask = getNotifyTaskModel();

  // 关联渠道
  const Producer = getProducerModel();
  NotifyTask.belongsTo(Producer);

  // 查询
  const notifyTasks = await NotifyTask.findAll({
    where: {
      id: { [Op.in]: taskIds },
    },
    include: Producer,
  });
  if (!notifyTasks || !notifyTasks.length) return notifyTasks;

  // 查询密钥
  const allSecret = await getSecretModel().findAll({
    where: {
      producerId: {
        [Op.in]: notifyTasks.map((t) => t.producerId),
      },
    },
    group: 'producerId',
  });

  // 数据处理
  notifyTasks.forEach((task, i) => {
    // 解析数据
    if (task.data) {
      try {
        notifyTasks[i].dataParsed = JSON.parse(task.data);
      } catch (error) {
        throw error500('通知任务数据有误(data)', { cause: error });
      }
    } else {
      notifyTasks[i].dataParsed = {};
    }

    // 密钥
    notifyTasks[i].Secrets = allSecret.filter(
      (s) => s.producerId === task.producerId,
    );
  });

  return notifyTasks;
};

/**
 * 更新通知任务
 * @param {object} values 需要更新的键值
 * @param {object} where 条件
 */
const updateNotifyTask = async (values, where) => {
  await getNotifyTaskModel().update(values, { where });
};

module.exports = {
  queryTasks,
  updateNotifyTask,
};
