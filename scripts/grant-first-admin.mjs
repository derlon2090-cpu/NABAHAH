import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: ".env.local" });
const authorizedEmail = "nabahah.official@gmail.com";
const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query("BEGIN");
  const account = await client.query('SELECT id FROM public."user" WHERE lower(email)=lower($1) AND email_verified=true FOR SHARE', [authorizedEmail]);
  if (account.rowCount !== 1) {
    await client.query("ROLLBACK");
    console.log("Admin bootstrap pending: the authorized Neon Auth account must sign up first.");
    process.exitCode = 2;
  } else {
    await client.query(
      "INSERT INTO nabaha_question_bank.nabaha_admin_users(auth_user_id,granted_by) VALUES($1,$2) ON CONFLICT(auth_user_id) DO NOTHING",
      [account.rows[0].id, "initial_bootstrap"],
    );
    await client.query("COMMIT");
    console.log("First admin grant verified.");
  }
} catch {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error("Admin bootstrap failed; details withheld.");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
