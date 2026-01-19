const rejectedAgentsByOrder = new Map();
const returnedAtByOrder = new Map();

function noteAgentRejected(orderId, agentId) {
  const key = String(orderId);
  const agentKey = String(agentId);

  const set = rejectedAgentsByOrder.get(key) ?? new Set();
  set.add(agentKey);
  rejectedAgentsByOrder.set(key, set);

  returnedAtByOrder.set(key, new Date().toISOString());
}

function getRejectedAgentIds(orderId) {
  const key = String(orderId);
  const set = rejectedAgentsByOrder.get(key);
  return set ? Array.from(set) : [];
}

function getReturnedAt(orderId) {
  const key = String(orderId);
  return returnedAtByOrder.get(key) ?? null;
}

module.exports = {
  noteAgentRejected,
  getRejectedAgentIds,
  getReturnedAt,
};
