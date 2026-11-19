-- Immutable audit trail for administrative role assignments.
-- Both participants are RESTRICTed: deleting either user would otherwise destroy
-- who changed a role or which account was affected.
CREATE TABLE "user_role_changes" (
  "id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "target_user_id" UUID NOT NULL,
  "previous_role" "Role" NOT NULL,
  "new_role" "Role" NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_role_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_role_changes_role_transition_check" CHECK ("previous_role" <> "new_role")
);

CREATE INDEX "user_role_changes_target_user_id_created_at_idx"
  ON "user_role_changes"("target_user_id", "created_at");
CREATE INDEX "user_role_changes_actor_id_created_at_idx"
  ON "user_role_changes"("actor_id", "created_at");

ALTER TABLE "user_role_changes"
  ADD CONSTRAINT "user_role_changes_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "user_role_changes_target_user_id_fkey"
    FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
