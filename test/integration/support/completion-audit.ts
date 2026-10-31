import type { Pool } from 'pg';

/**
 * Records, inside the transaction that finishes a job, how many log lines it has stored by then:
 * a job may only report completed or cancelled once its log is saved. Test databases only.
 */
export async function auditLogAtCompletion(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE completion_audit (job_id uuid PRIMARY KEY, log_lines integer NOT NULL);
    CREATE FUNCTION audit_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO completion_audit
        SELECT NEW.id, count(*) FROM job_logs WHERE job_id = NEW.id
        ON CONFLICT (job_id) DO NOTHING;
      RETURN NEW;
    END $$;
    CREATE TRIGGER audit_completion AFTER UPDATE OF status ON jobs FOR EACH ROW
      WHEN (NEW.status IN ('completed', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION audit_completion();
  `);
}

/** Log lines the job had when it was marked finished, or undefined if it never was. */
export async function logLinesAtCompletion(pool: Pool, jobId: string): Promise<number | undefined> {
  const { rows } = await pool.query<{ log_lines: number }>(
    'SELECT log_lines FROM completion_audit WHERE job_id = $1',
    [jobId],
  );
  return rows[0]?.log_lines;
}
