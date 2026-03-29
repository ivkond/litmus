import 'dotenv/config';
import { uploadFile, downloadFile, deleteFile, BUCKETS } from './s3';

const TEST_KEY = '_smoke-test/probe.txt';
const TEST_BODY = `litmus-s3-smoke-test-${Date.now()}`;

async function smokeTest() {
  console.log('S3 smoke test: put -> get -> delete');

  // PUT
  console.log(`  PUT ${BUCKETS.scenarios}/${TEST_KEY}`);
  await uploadFile(BUCKETS.scenarios, TEST_KEY, TEST_BODY, 'text/plain');

  // GET
  console.log(`  GET ${BUCKETS.scenarios}/${TEST_KEY}`);
  const downloaded = await downloadFile(BUCKETS.scenarios, TEST_KEY);
  const content = downloaded.toString('utf-8');

  if (content !== TEST_BODY) {
    throw new Error(`Content mismatch: expected "${TEST_BODY}", got "${content}"`);
  }
  console.log('  Content matches.');

  // DELETE
  console.log(`  DELETE ${BUCKETS.scenarios}/${TEST_KEY}`);
  await deleteFile(BUCKETS.scenarios, TEST_KEY);

  console.log('S3 smoke test PASSED.');
}

smokeTest().catch((err) => {
  console.error('S3 smoke test FAILED:', err);
  process.exit(1);
});
