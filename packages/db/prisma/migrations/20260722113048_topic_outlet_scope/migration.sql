-- AlterTable
ALTER TABLE "topics" ADD COLUMN     "outlet_id" UUID;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
