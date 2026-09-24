-- Keyword search (issue #66, ADR-0067): the first escalation ADR-0019 names, and
-- nothing past it. No embedding, no vector, no similarity between records.
--
-- One GENERATED column per searched table, derived by the database from the row's
-- own text: no writer maintains it, so it cannot drift from what it indexes, and
-- nothing selects it. Each expression is immutable — `coalesce`, `||`, `left` and
-- `to_tsvector` with a fixed configuration — which a generated column requires;
-- `concat_ws` is not, which is why it is spelled out.
--
-- **The OCR text is read to its first 300,000 characters**, `EXTRACTION_TEXT_MAX`
-- (ADR-0063). Postgres refuses a tsvector over 1 MB, and OCR text is stored whole
-- however long it is (issue #132): over a 2,000-page document the column would
-- refuse the row, which is the extraction failing to store what the vendor read.
-- At 300,000 characters the worst case is about 680 KB. Every other column here is
-- bounded well below that at its route (an arrival's body at 262,144 characters,
-- the memory at 32,768).
--
-- English stemming: *flooded* finds *flooding*.

ALTER TABLE "projects" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("project_number", '') || ' ' || coalesce("name", ''))) STORED;
CREATE INDEX "projects_search_vector_idx" ON "projects" USING GIN ("search_vector");

ALTER TABLE "open_items" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("unresolved", '') || ' ' || coalesce("blocks", '') || ' ' || coalesce("waiting_on", '') || ' ' || coalesce("resolution_note", '') || ' ' || coalesce("counterfactual", ''))) STORED;
CREATE INDEX "open_items_search_vector_idx" ON "open_items" USING GIN ("search_vector");

ALTER TABLE "submissions" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("recipient", '') || ' ' || coalesce("recipient_role", '') || ' ' || coalesce("sheet_list", '') || ' ' || coalesce("revision", ''))) STORED;
CREATE INDEX "submissions_search_vector_idx" ON "submissions" USING GIN ("search_vector");

ALTER TABLE "assumption_records" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("assumptions", '') || ' ' || coalesce("flags", '') || ' ' || coalesce("code_edition", ''))) STORED;
CREATE INDEX "assumption_records_search_vector_idx" ON "assumption_records" USING GIN ("search_vector");

ALTER TABLE "observations" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("observed", '') || ' ' || coalesce("floor", '') || ' ' || coalesce("qualifier", ''))) STORED;
CREATE INDEX "observations_search_vector_idx" ON "observations" USING GIN ("search_vector");

ALTER TABLE "issues" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("closure_note", ''))) STORED;
CREATE INDEX "issues_search_vector_idx" ON "issues" USING GIN ("search_vector");

ALTER TABLE "register_entries" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("number", '') || ' ' || coalesce("subject", '') || ' ' || coalesce("from_party", '') || ' ' || coalesce("to_party", '') || ' ' || coalesce("question", '') || ' ' || coalesce("response", ''))) STORED;
CREATE INDEX "register_entries_search_vector_idx" ON "register_entries" USING GIN ("search_vector");

ALTER TABLE "documents" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("title", ''))) STORED;
CREATE INDEX "documents_search_vector_idx" ON "documents" USING GIN ("search_vector");

ALTER TABLE "document_versions" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("filename", '') || ' ' || coalesce("revision", ''))) STORED;
CREATE INDEX "document_versions_search_vector_idx" ON "document_versions" USING GIN ("search_vector");

ALTER TABLE "ingested_documents" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("sender", '') || ' ' || coalesce("subject", '') || ' ' || coalesce("body", '') || ' ' || coalesce("note", ''))) STORED;
CREATE INDEX "ingested_documents_search_vector_idx" ON "ingested_documents" USING GIN ("search_vector");

ALTER TABLE "register_entry_extractions" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce(left("ocr_text", 300000), '') || ' ' || coalesce("proposed_number", '') || ' ' || coalesce("proposed_subject", '') || ' ' || coalesce("proposed_from_party", '') || ' ' || coalesce("proposed_to_party", '') || ' ' || coalesce("proposed_question", '') || ' ' || coalesce("proposed_response", '') || ' ' || coalesce("proposed_party", '') || ' ' || coalesce("proposed_title", '') || ' ' || coalesce("proposed_revision", ''))) STORED;
CREATE INDEX "register_entry_extractions_search_vector_idx" ON "register_entry_extractions" USING GIN ("search_vector");

ALTER TABLE "project_memory_versions" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("content", ''))) STORED;
CREATE INDEX "project_memory_versions_search_vector_idx" ON "project_memory_versions" USING GIN ("search_vector");
