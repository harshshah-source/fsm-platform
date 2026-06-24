-- CreateEnum
CREATE TYPE "role" AS ENUM ('SERVICE_ENGINEER', 'ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD', 'WAREHOUSE_MANAGER');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "users" (
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "zone_id" BIGINT,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_zone_id_idx" ON "users"("zone_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("zone_id") ON DELETE SET NULL ON UPDATE CASCADE;
