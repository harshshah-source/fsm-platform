-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);
