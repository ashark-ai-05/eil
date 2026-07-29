-- The third step of detect -> quarantine -> review.
--
-- `eil quarantine clear` could not work without this. Clearing the flag and
-- re-ingesting simply re-ran the scanner, which found the same credential and
-- re-quarantined the document — correct for a real secret, and useless for a
-- false positive, which is by definition a body that legitimately contains a
-- key-shaped string (a test fixture, an example in documentation, a placeholder
-- that happens to match a registered prefix).
--
-- Accepted findings are stored per document, and the scanner quarantines only
-- what is NOT accepted. Keying on rule + hint rather than on the document means
-- acceptance does not blanket-approve the file: if the body later gains a
-- DIFFERENT credential, its hint differs, it is unaccepted, and the document is
-- quarantined again. Accepting one finding cannot silently accept the next one.
ALTER TABLE documents ADD COLUMN secret_accepted jsonb;
ALTER TABLE documents ADD COLUMN secret_reviewed_at timestamptz;
ALTER TABLE documents ADD COLUMN secret_reviewed_by text;
