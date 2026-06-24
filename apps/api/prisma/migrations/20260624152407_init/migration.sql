-- CreateTable
CREATE TABLE "Page" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "finalUrl" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "contentType" TEXT,
    "title" TEXT,
    "html" TEXT,
    "contentHash" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Link" (
    "id" TEXT NOT NULL,
    "fromPageId" TEXT NOT NULL,
    "toUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Page_url_key" ON "Page"("url");

-- CreateIndex
CREATE INDEX "Page_fetchedAt_idx" ON "Page"("fetchedAt");

-- CreateIndex
CREATE INDEX "Link_toUrl_idx" ON "Link"("toUrl");

-- CreateIndex
CREATE UNIQUE INDEX "Link_fromPageId_toUrl_key" ON "Link"("fromPageId", "toUrl");

-- AddForeignKey
ALTER TABLE "Link" ADD CONSTRAINT "Link_fromPageId_fkey" FOREIGN KEY ("fromPageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
