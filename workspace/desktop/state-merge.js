function newest(left, right) {
  if (!left) return right;
  if (!right) return left;
  return String(right.updatedAt || right.savedAt || '').localeCompare(String(left.updatedAt || left.savedAt || '')) >= 0 ? right : left;
}

function mergeById(current = [], incoming = []) {
  const result = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => result.set(item.id, newest(result.get(item.id), item)));
  return [...result.values()];
}

function mergeWorkspaceState(current = {}, incoming = {}) {
  const deletedConnectionIds = [...new Set([...(current.deletedConnectionIds || []), ...(incoming.deletedConnectionIds || [])])];
  const deletedLibraryIds = [...new Set([...(current.deletedLibraryIds || []), ...(incoming.deletedLibraryIds || [])])];
  const scalarSource = newest(current, incoming) || incoming;
  const projects = mergeById(current.projects, incoming.projects);
  const connections = mergeById(current.connections, incoming.connections).filter((item) => !deletedConnectionIds.includes(item.id));
  const quickWorkspaces = { ...(current.quickWorkspaces || {}) };
  Object.entries(incoming.quickWorkspaces || {}).forEach(([key, value]) => { quickWorkspaces[key] = newest(quickWorkspaces[key], value); });
  const quickTasks = { ...(current.quickTasks || {}) };
  Object.entries(incoming.quickTasks || {}).forEach(([key, list]) => { quickTasks[key] = mergeById(quickTasks[key], list); });
  const library = {};
  ['rosters', 'mailTemplates', 'layoutTemplates'].forEach((key) => { library[key] = mergeById(current.library?.[key], incoming.library?.[key]).filter((item) => !deletedLibraryIds.includes(item.id)); });
  return {
    ...current,
    ...incoming,
    ...scalarSource,
    projects,
    connections,
    quickWorkspaces,
    quickTasks,
    library,
    deletedConnectionIds,
    deletedLibraryIds
  };
}

module.exports = { mergeWorkspaceState };
