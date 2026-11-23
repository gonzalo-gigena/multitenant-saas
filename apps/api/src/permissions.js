// The role-permission matrix. README.md shows the same table, and integration/roles.js
// fails if the two differ or if any cell isn't enforced by the routes.
export const ROLES = ['owner', 'admin', 'staff'];

export const PERMISSIONS = {
  services: { read: ['owner', 'admin', 'staff'], write: ['owner', 'admin'] },
  appointments: { read: ['owner', 'admin', 'staff'], write: ['owner', 'admin', 'staff'] },
  members: { read: ['owner', 'admin', 'staff'], manage: ['owner'] },
  invites: { read: ['owner', 'admin'], write: ['owner', 'admin'] },
};

// The one check every tenant route goes through: server.js calls it before any handler runs.
export const can = (user, action, resource) =>
  Object.hasOwn(PERMISSIONS, resource) && Object.hasOwn(PERMISSIONS[resource], action) &&
  PERMISSIONS[resource][action].includes(user?.role);
