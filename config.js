// ⚠️ 이 파일에는 "anon / publishable" key만 넣으세요.
// service_role key(비밀 키)는 절대 넣지 마세요! 브라우저에 노출되면 안 됩니다.
//
// Supabase 대시보드 > Settings > API 에서 확인:
// - Project URL          → SUPABASE_URL
// - anon public / publishable key → SUPABASE_ANON_KEY

window.HODULOG_CONFIG = {
  SUPABASE_URL: 'https://uwxgcqhhkfmtqqoihsdi.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_ITpiQmUejZZxbHVmqP9waQ_2-wYMnRY',

  // 사진을 저장할 Storage 버킷 이름 (supabase-setup.sql 에서 만드는 이름과 반드시 일치해야 함)
  STORAGE_BUCKET: 'hodulog-photos',
};
