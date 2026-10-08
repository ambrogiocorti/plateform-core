import assert from 'node:assert/strict';
import { database, identity, ids, seed } from '../tests/database/harness.ts';

const db = await database();
const galleryKey = 'c2000000-0000-4000-8000-000000000001';
const secondKey = 'c2000000-0000-4000-8000-000000000002';
const documentKey = 'c2000000-0000-4000-8000-000000000003';
const checksum = 'a'.repeat(64);
try {
  await seed(db);
  await identity(db, ids.admin);

  const first = (
    await db.query(
      "select public.reserve_asset_upload_command('gallery',null,$1,100,'image/png',$2,$3) r",
      [ids.venue, checksum, galleryKey],
    )
  ).rows[0]?.r;
  assert.ok(first?.id && first?.path, 'gallery upload reservation created');
  assert.ok(first.path.startsWith(`${ids.venue}/brand/`), 'venue asset path is scoped');

  const replay = (
    await db.query(
      "select public.reserve_asset_upload_command('gallery',null,$1,100,'image/png',$2,$3) r",
      [ids.venue, checksum, galleryKey],
    )
  ).rows[0]?.r;
  assert.deepEqual(replay, first, 'asset reservation replay is idempotent');

  await assert.rejects(
    () =>
      db.query(
        "select public.reserve_asset_upload_command('gallery',null,$1,100,'image/png',$2,$3)",
        [ids.venue, 'b'.repeat(64), galleryKey],
      ),
    /IDEMPOTENCY_MISMATCH/,
  );
  await assert.rejects(
    () =>
      db.query(
        "select public.reserve_asset_upload_command('gallery',null,$1,100,'application/pdf',$2,$3)",
        [ids.venue, checksum, secondKey],
      ),
    /INVALID_ASSET/,
  );
  await assert.rejects(
    () =>
      db.query(
        "select public.reserve_asset_upload_command('branding',null,null,100,'image/png',$1,$2)",
        [checksum, secondKey],
      ),
    /CHAIN_SCOPE_REQUIRED/,
  );

  await db.exec('reset role');
  await identity(db, ids.host);
  await assert.rejects(
    () =>
      db.query(
        "select public.reserve_asset_upload_command('gallery',null,$1,100,'image/png',$2,$3)",
        [ids.venue, checksum, secondKey],
      ),
    /FORBIDDEN/,
  );

  await db.exec('reset role; set role service_role');
  await db.query('select public.finish_asset_upload($1,true,$2)', [first.id, checksum]);
  await db.exec('reset role');
  assert.deepEqual(
    (await db.query('select status,checksum from public.asset_uploads where id=$1', [first.id]))
      .rows[0],
    { status: 'SAVED', checksum },
    'service boundary finalizes the uploaded asset',
  );
  await db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)', [
    'gallery',
    first.path,
    JSON.stringify({ size: 100, mimetype: 'image/png' }),
  ]);
  await db.exec('set role anon');
  assert.equal(
    (
      await db.query(
        'select count(*)::int count from storage.objects where bucket_id=$1 and name=$2',
        ['gallery', first.path],
      )
    ).rows[0]?.count,
    1,
    'public gallery asset is readable anonymously',
  );

  await db.exec('reset role');
  await identity(db, ids.admin);
  const document = (
    await db.query(
      "select public.reserve_asset_upload_command('documents',null,$1,120,'application/pdf',$2,$3) r",
      [ids.venue, checksum, documentKey],
    )
  ).rows[0]?.r;
  assert.ok(document?.id && document?.path);
  await db.exec('reset role; set role service_role');
  await db.query('select public.finish_asset_upload($1,true,$2)', [document.id, checksum]);
  await db.exec('reset role');
  await db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)', [
    'documents',
    document.path,
    JSON.stringify({ size: 120, mimetype: 'application/pdf' }),
  ]);

  await identity(db, ids.admin);
  assert.equal(
    (
      await db.query(
        'select count(*)::int count from storage.objects where bucket_id=$1 and name=$2',
        ['documents', document.path],
      )
    ).rows[0]?.count,
    1,
    'venue Admin can read the private document metadata',
  );
  await db.exec('reset role');
  await identity(db, ids.host);
  assert.equal(
    (
      await db.query(
        'select count(*)::int count from storage.objects where bucket_id=$1 and name=$2',
        ['documents', document.path],
      )
    ).rows[0]?.count,
    0,
    'Host cannot read private document metadata',
  );

  await db.exec('reset role');
  await db.exec('update public.system_limits set max_storage_bytes=250 where id');
  await identity(db, ids.admin);
  await assert.rejects(
    () =>
      db.query(
        "select public.reserve_asset_upload_command('gallery',null,$1,100,'image/png',$2,$3)",
        [ids.venue, checksum, secondKey],
      ),
    /STORAGE_LIMIT/,
    'server-side storage quota includes reserved/saved uploads',
  );

  console.log('STEP11_ASSET_BOUNDARY_GATE=PASSED');
} finally {
  await db.exec('reset role').catch(() => undefined);
  await db.close();
}
