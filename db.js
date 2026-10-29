'use strict';
const { Pool } = require('pg');
const crypto = require('crypto');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.env.CREDENTIAL_ENCRYPTION_KEY) throw new Error('CREDENTIAL_ENCRYPTION_KEY is required');
const key = Buffer.from(process.env.CREDENTIAL_ENCRYPTION_KEY, 'hex');
if (key.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes in hex (64 characters)');
// Supabase's IPv4 session pooler may present a certificate chain signed by a
// provider-specific CA. Keep verification enabled and support an explicit CA.
// Do not use rejectUnauthorized:false or NODE_TLS_REJECT_UNAUTHORIZED=0.
const connectionString = process.env.DATABASE_URL;
const ca = process.env.DATABASE_CA_CERT;
const ssl = ca ? { rejectUnauthorized: true, ca: ca.replace(/\\n/g, '\n') } : { rejectUnauthorized: true };
const pool = new Pool({ connectionString, max: 5, ssl });
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
function decrypt(value) {
  const bytes = Buffer.from(value, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schedules (
    id text PRIMARY KEY, name text NOT NULL, link text NOT NULL,
    status text NOT NULL, created_at bigint NOT NULL, finished_at bigint, last_error text
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS schedule_legs (
    schedule_id text NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    id integer NOT NULL, service_id text NOT NULL, link text NOT NULL,
    quantity integer NOT NULL, category text NOT NULL, service_label text NOT NULL,
    base_url text NOT NULL, encrypted_api_key text NOT NULL, due_at bigint NOT NULL,
    status text NOT NULL, provider_order_id text, error text, finished_at bigint,
    PRIMARY KEY(schedule_id,id)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS schedule_legs_due_idx ON schedule_legs(status,due_at)');
  await pool.query(`CREATE TABLE IF NOT EXISTS activity_entries (
    id bigserial PRIMARY KEY, timestamp bigint NOT NULL, payload jsonb NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS delivery_entries (
    id bigserial PRIMARY KEY, timestamp bigint NOT NULL, payload jsonb NOT NULL
  )`);
}
async function create(order, activity) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('INSERT INTO schedules VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [order.id,order.name,order.link,order.status,order.createdAt,null,null]);
    for (const l of order.legs) {
      await c.query(`INSERT INTO schedule_legs
        (schedule_id,id,service_id,link,quantity,category,service_label,base_url,encrypted_api_key,due_at,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'waiting')`,
        [order.id,l.id,l.serviceId,l.link,l.quantity,l.category,l.serviceLabel,l.baseUrl,encrypt(l.apiKey),l.dueAt]);
    }
    await c.query('INSERT INTO activity_entries(timestamp,payload) VALUES($1,$2)',[Date.now(),activity]);
    await c.query('COMMIT');
  } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
function fromRows(rows) {
  const orders = new Map();
  for(const r of rows) {
    if(!orders.has(r.schedule_id)) orders.set(r.schedule_id,{
      id:r.schedule_id,name:r.name,link:r.schedule_link,status:r.schedule_status,
      createdAt:Number(r.created_at),finishedAt:r.schedule_finished_at?Number(r.schedule_finished_at):null,
      lastError:r.last_error,legs:[]
    });
    if(r.id!==null) orders.get(r.schedule_id).legs.push({
      id:r.id,serviceId:r.service_id,link:r.link,quantity:r.quantity,
      category:r.category,serviceLabel:r.service_label,baseUrl:r.base_url,
      dueAt:Number(r.due_at),status:r.status,providerOrderId:r.provider_order_id,
      error:r.error,finishedAt:r.finished_at?Number(r.finished_at):null
    });
  }
  return [...orders.values()];
}
async function list() {
  const {rows}=await pool.query(`SELECT s.id AS schedule_id,s.name,s.link AS schedule_link,
    s.status AS schedule_status,s.created_at,s.finished_at AS schedule_finished_at,s.last_error,
    l.* FROM schedules s LEFT JOIN schedule_legs l ON l.schedule_id=s.id
    ORDER BY s.created_at DESC,l.id ASC`);
  return fromRows(rows);
}
async function get(id) { return (await list()).find(o=>o.id===id); }
async function claim() {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const {rows}=await c.query(`SELECT l.* FROM schedule_legs l JOIN schedules s ON s.id=l.schedule_id
      WHERE l.status='waiting' AND s.status='running' AND l.due_at <= $1
      ORDER BY l.due_at LIMIT 1 FOR UPDATE OF l SKIP LOCKED`,[Date.now()]);
    if(!rows.length) { await c.query('COMMIT'); return null; }
    const r=rows[0];
    await c.query("UPDATE schedule_legs SET status='processing' WHERE schedule_id=$1 AND id=$2",[r.schedule_id,r.id]);
    await c.query('COMMIT');
    return {orderId:r.schedule_id,id:r.id,serviceId:r.service_id,link:r.link,quantity:r.quantity,
      category:r.category,serviceLabel:r.service_label,baseUrl:r.base_url,apiKey:decrypt(r.encrypted_api_key)};
  } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
async function finish(leg, result) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE schedule_legs SET status=$3,provider_order_id=$4,error=$5,finished_at=$6
      WHERE schedule_id=$1 AND id=$2 AND status='processing'`,
      [leg.orderId,leg.id,result.status,result.providerOrderId||null,result.error||null,Date.now()]);
    if(result.error) await c.query('UPDATE schedules SET last_error=$2 WHERE id=$1',[leg.orderId,result.error]);
    const activity={type:result.status==='completed'?'leg_completed':'leg_failed',orderId:leg.orderId,
      link:leg.link,category:leg.category,quantity:leg.quantity,
      ...(result.providerOrderId?{providerOrderId:result.providerOrderId}:{}),
      ...(result.error?{error:result.error}:{})};
    await c.query('INSERT INTO activity_entries(timestamp,payload) VALUES($1,$2)',[Date.now(),activity]);
    if(result.status==='completed') {
      const delivery={timestamp:Date.now(),link:leg.link,category:leg.category,amount:leg.quantity,
        serviceLabel:leg.serviceLabel,orderId:leg.orderId,providerOrderId:result.providerOrderId||null};
      await c.query('INSERT INTO delivery_entries(timestamp,payload) VALUES($1,$2)',[delivery.timestamp,delivery]);
    }
    const pending=await c.query(`SELECT COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE status IN ('failed','uncertain'))::int AS failed
      FROM schedule_legs WHERE schedule_id=$1`,[leg.orderId]);
    const totals=await c.query('SELECT COUNT(*)::int AS count FROM schedule_legs WHERE schedule_id=$1 AND status IN (\'waiting\',\'processing\')',[leg.orderId]);
    if(totals.rows[0].count===0) {
      const status=pending.rows[0].failed?'failed':'completed';
      await c.query('UPDATE schedules SET status=$2,finished_at=$3 WHERE id=$1',[leg.orderId,status,Date.now()]);
      await c.query('INSERT INTO activity_entries(timestamp,payload) VALUES($1,$2)',[Date.now(),{type:'schedule_finished',orderId:leg.orderId,status}]);
    }
    await c.query('COMMIT');
  } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
async function changeStatus(id,action) {
  const status=action==='pause'?'paused':'running';
  const r=await pool.query(`UPDATE schedules SET status=$2 WHERE id=$1 AND status IN ('running','paused') RETURNING id`,[id,status]);
  if(r.rowCount) await log({type:action==='pause'?'schedule_paused':'schedule_resumed',orderId:id});
  return r.rowCount>0;
}
async function remove(id) {
  const r=await pool.query('DELETE FROM schedules WHERE id=$1 RETURNING name',[id]);
  if(r.rowCount) await log({type:'schedule_deleted',orderId:id,name:r.rows[0].name});
  return r.rowCount>0;
}
async function log(payload) { await pool.query('INSERT INTO activity_entries(timestamp,payload) VALUES($1,$2)',[Date.now(),payload]); }
async function activities() {
  const {rows}=await pool.query('SELECT timestamp,payload FROM activity_entries ORDER BY id DESC LIMIT 2000');
  return rows.map(r=>({timestamp:Number(r.timestamp),...r.payload}));
}
async function deliveries(link) {
  const {rows}=await pool.query('SELECT timestamp,payload FROM delivery_entries '+(link?'WHERE payload->>\'link\'=$1 ':'')+'ORDER BY id DESC LIMIT 2000',link?[link]:[]);
  return rows.map(r=>({timestamp:Number(r.timestamp),...r.payload}));
}
async function markInterrupted() {
  // A provider may have accepted a request before a crash; never auto-retry it.
  const {rows}=await pool.query(`UPDATE schedule_legs SET status='uncertain',
    error='Backend interrupted during submission; verify provider history before retrying'
    WHERE status='processing' RETURNING schedule_id,id`);
  for(const r of rows) await log({type:'leg_failed',orderId:r.schedule_id,
    error:'Submission outcome unknown after restart; check provider history'});
}
module.exports={init,create,list,get,claim,finish,changeStatus,remove,log,activities,deliveries,markInterrupted,pool};
