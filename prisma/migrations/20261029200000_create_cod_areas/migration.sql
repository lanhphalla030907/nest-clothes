CREATE TABLE "cod_areas" (
    "id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "cod_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "cod_areas_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cod_areas_code_canonical" CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'),
    CONSTRAINT "cod_areas_name_non_blank" CHECK (length(btrim("name")) > 0)
);

CREATE UNIQUE INDEX "cod_areas_code_key" ON "cod_areas"("code");

CREATE INDEX "cod_areas_cod_enabled_name_idx"
  ON "cod_areas"("cod_enabled", "name");
