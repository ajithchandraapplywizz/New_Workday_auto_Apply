import { signJwt } from '../lib/authService.mjs';

async function testHttp() {
  console.log('=== TEST 1: Manager Token ===');
  const mgrToken = signJwt({
    email: 'balaji@applywizz.ai',
    role: 'manager',
    manager_id: '9dc9376e-fbc5-440b-932f-38da10b89a70',
    name: 'Balaji'
  });
  const resMgr = await fetch('http://localhost:3001/api/admin/dashboard?range=today', {
    headers: { 'Authorization': `Bearer ${mgrToken}` }
  });
  const bodyMgr = await resMgr.json();
  console.log('Manager Status:', resMgr.status);
  console.log('Manager Tasks (today):', bodyMgr.tasks);
  console.log('Manager AnswerSources (today):', bodyMgr.answerSources);
  console.log('Manager CAs:', bodyMgr.cas?.total);

  console.log('\n=== TEST 2: Admin Token for range=today ===');
  const adminToken = signJwt({ email: 'admin@applywizz.ai', role: 'admin', name: 'Admin User' });
  const resAdminToday = await fetch('http://localhost:3001/api/admin/dashboard?range=today', {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const bodyAdminToday = await resAdminToday.json();
  console.log('Admin Today Tasks:', bodyAdminToday.tasks);
  console.log('Admin Today AnswerSources:', bodyAdminToday.answerSources);
}

testHttp().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
