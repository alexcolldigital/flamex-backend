/* eslint-disable no-console */
const axios = require('axios');

const apiBaseUrl = (process.env.STAGING_API_URL || process.env.API_URL || 'http://localhost:5000').replace(/\/$/, '');

function client(token = null) {
  return axios.create({
    baseURL: `${apiBaseUrl}/api`,
    timeout: 20000,
    headers: token
      ? {
          Authorization: `Bearer ${token}`
        }
      : {}
  });
}

async function runStep(name, fn, { optional = false } = {}) {
  try {
    const result = await fn();
    console.log(`PASS ${name}`);
    return { ok: true, result };
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    if (optional) {
      console.log(`SKIP ${name}: ${message}`);
      return { ok: false, skipped: true, error: message };
    }
    console.log(`FAIL ${name}: ${message}`);
    throw error;
  }
}

async function main() {
  console.log(`Smoke target: ${apiBaseUrl}`);

  await runStep('health', async () => {
    const response = await axios.get(`${apiBaseUrl}/health`, { timeout: 10000 });
    return response.data;
  });

  let adminToken = null;
  if (process.env.STAGING_ADMIN_EMAIL && process.env.STAGING_ADMIN_PASSWORD) {
    const adminLogin = await runStep('admin login', async () => {
      const response = await client().post('/auth/admin/login', {
        email: process.env.STAGING_ADMIN_EMAIL,
        password: process.env.STAGING_ADMIN_PASSWORD
      });
      adminToken = response.data.token;
      return response.data.user;
    });

    if (adminLogin.ok) {
      const adminClient = client(adminToken);
      await runStep('admin overview', async () => (await adminClient.get('/admin/dashboard/overview')).data);
      await runStep('admin treasury', async () => (await adminClient.get('/admin/p2p/treasury')).data);
      await runStep('admin audit logs', async () => (await adminClient.get('/admin/audit-logs')).data);
    }
  } else {
    console.log('SKIP admin login: STAGING_ADMIN_EMAIL and STAGING_ADMIN_PASSWORD not provided');
  }

  let userToken = null;
  if (process.env.STAGING_USER_EMAIL && process.env.STAGING_USER_PASSWORD) {
    const userLogin = await runStep('user login', async () => {
      const response = await client().post('/auth/login', {
        email: process.env.STAGING_USER_EMAIL,
        password: process.env.STAGING_USER_PASSWORD
      });
      userToken = response.data.token;
      return response.data.user;
    });

    if (userLogin.ok) {
      const userClient = client(userToken);
      await runStep('user profile', async () => (await userClient.get('/auth/me')).data);
      await runStep('wallet summary', async () => (await userClient.get('/wallet')).data);
      await runStep('notifications', async () => (await userClient.get('/notifications')).data);
      await runStep('bill providers', async () => (await userClient.get('/bills/providers')).data);
      await runStep('p2p offers', async () => (await userClient.get('/p2p/offers')).data);
    }
  } else {
    console.log('SKIP user login: STAGING_USER_EMAIL and STAGING_USER_PASSWORD not provided');
  }

  console.log('Smoke test complete');
}

main().catch((error) => {
  console.error('Smoke test failed');
  process.exitCode = 1;
});
