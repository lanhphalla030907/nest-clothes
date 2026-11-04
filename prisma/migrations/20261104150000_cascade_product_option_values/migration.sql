ALTER TABLE "product_option_values"
DROP CONSTRAINT "product_option_values_product_option_id_product_id_fkey";

ALTER TABLE "product_option_values"
ADD CONSTRAINT "product_option_values_product_option_id_product_id_fkey"
FOREIGN KEY ("product_option_id", "product_id")
REFERENCES "product_options"("id", "product_id")
ON DELETE CASCADE
ON UPDATE CASCADE;
