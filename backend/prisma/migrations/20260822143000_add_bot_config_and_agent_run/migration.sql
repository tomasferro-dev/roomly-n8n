
-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('OK', 'FAILED', 'EMPTY', 'SKIPPED');

-- CreateTable
CREATE TABLE "BotConfig" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "systemPrompt" TEXT,
    "model" TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 512,
    "memoryWindow" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT,
    "phone" TEXT NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'WHATSAPP',
    "inboundText" TEXT NOT NULL,
    "outboundText" TEXT,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'OK',
    "error" TEXT,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER,
    "outputTokens" INTEGER,
    "iterations" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotConfig_hotelId_key" ON "BotConfig"("hotelId");

-- CreateIndex
CREATE INDEX "AgentRun_phone_createdAt_idx" ON "AgentRun"("phone", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_createdAt_idx" ON "AgentRun"("createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_status_idx" ON "AgentRun"("status");

-- AddForeignKey
ALTER TABLE "BotConfig" ADD CONSTRAINT "BotConfig_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

