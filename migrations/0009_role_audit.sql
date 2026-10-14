-- Role changes now live in the general audit log; history keeps its original actor, target and time.
INSERT INTO audit_logs(id,actor,action,target,details_json,created_at)
 SELECT 'role-audit:' || id, actor_id, CASE WHEN admin=1 THEN 'role.grant' ELSE 'role.revoke' END, target_id, json_object('admin', json(CASE WHEN admin=1 THEN 'true' ELSE 'false' END), 'migratedFrom', 'integration_role_audit'), created_at FROM integration_role_audit;
DROP TABLE integration_role_audit;
