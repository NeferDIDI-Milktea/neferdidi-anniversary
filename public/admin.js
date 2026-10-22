(() => {
  const $ = id => document.getElementById(id);
  const loginView = $('loginView'); const dashboardView = $('dashboardView'); const gallery = $('gallery');
  let allItems = [];
  const fmtDate = value => { try { return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); } catch { return value || ''; } };
  const fmtSize = bytes => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok) throw new Error(body?.error || 'حصلت مشكلة في الاتصال بالسيرفر.');
    return body;
  }
  function showLogin() { loginView.classList.remove('hidden'); dashboardView.classList.add('hidden'); }
  function showDashboard() { loginView.classList.add('hidden'); dashboardView.classList.remove('hidden'); }
  function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
  function renderCard(item) {
    const card = node('article', 'card');
    const media = node('div', 'media');
    const mediaUrl = `/api/admin/submissions/${encodeURIComponent(item.id)}/media`;
    if ((item.fileType || '').startsWith('image/')) {
      const img = node('img'); img.src = mediaUrl; img.alt = `مشاركة من ${item.name}`; img.loading = 'lazy'; media.append(img);
      img.addEventListener('error', () => { media.replaceChildren(node('p', 'missing', 'ملف الصورة غير متاح على السيرفر')); });
    } else if ((item.fileType || '').startsWith('video/')) {
      const video = node('video'); video.src = mediaUrl; video.controls = true; video.preload = 'metadata'; video.playsInline = true; media.append(video);
      video.addEventListener('error', () => { media.replaceChildren(node('p', 'missing', 'ملف الفيديو غير متاح على السيرفر')); });
    } else media.append(node('p', 'missing', 'نوع ملف غير معروف'));
    const content = node('div', 'card-content');
    const line = node('div', 'card-title-line'); const titleWrap = node('div'); titleWrap.append(node('h3', '', item.name || 'بدون اسم'));
    const subline = [item.branch, fmtSize(item.fileSize)].filter(Boolean).join(' · '); titleWrap.append(node('div', 'meta', subline));
    line.append(titleWrap, node('time', 'timestamp', fmtDate(item.createdAt))); content.append(line);
    if (item.note) content.append(node('p', 'note', item.note));
    const badge = node('span', `consent${item.consentMarketing ? '' : ' no'}`, item.consentMarketing ? '✓ موافق على الاستخدام التسويقي' : 'لا توجد موافقة تسويقية'); content.append(badge);
    const meta = node('p', 'meta', `${item.fileType || 'ملف'} · ${item.originalName || ''}`); content.append(meta);
    const actions = node('div', 'actions');
    const download = node('a', 'btn gold', 'تحميل الملف ↓'); download.href = `/api/admin/submissions/${encodeURIComponent(item.id)}/download`; download.setAttribute('download', '');
    const remove = node('button', 'delete', 'حذف المشاركة ×'); remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`متأكد إنك عاوز تحذف مشاركة ${item.name || ''} والملف المرتبط بيها نهائيًا؟`)) return;
      remove.disabled = true;
      try { await api(`/api/admin/submissions/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await loadSubmissions(); }
      catch (err) { alert(err.message); remove.disabled = false; }
    });
    actions.append(download, remove); content.append(actions); card.append(media, content); return card;
  }
  function render() {
    const query = $('searchInput').value.trim().toLocaleLowerCase(); const consent = $('consentFilter').value;
    const filtered = allItems.filter(item => {
      const text = [item.name, item.branch, item.note, item.originalName].join(' ').toLocaleLowerCase();
      return (!query || text.includes(query)) && (consent === 'all' || (consent === 'yes' ? !!item.consentMarketing : !item.consentMarketing));
    });
    $('totalCount').textContent = allItems.length;
    $('marketingCount').textContent = allItems.filter(item => item.consentMarketing).length;
    $('filteredCount').textContent = filtered.length;
    $('resultsText').textContent = filtered.length === allItems.length ? `عرض ${filtered.length} مشاركة` : `عرض ${filtered.length} من أصل ${allItems.length} مشاركة`;
    gallery.replaceChildren();
    if (!filtered.length) { gallery.append(node('div', 'empty', allItems.length ? 'مفيش مشاركات مطابقة للبحث ده.' : 'لسه مفيش مشاركات. أول ما العملاء يبعتوا لحظاتهم هتظهر هنا.')); return; }
    filtered.forEach(item => gallery.append(renderCard(item)));
  }
  async function loadSubmissions() {
    gallery.replaceChildren(node('div', 'empty', 'جاري تحميل المشاركات…'));
    try {
      const result = await api('/api/admin/submissions'); allItems = result.items || []; render();
    } catch (err) {
      if (err.message.includes('سجّل الدخول')) showLogin();
      gallery.replaceChildren(node('div', 'empty', err.message));
    }
  }
  async function checkSession() {
    try { await api('/api/admin/me'); showDashboard(); await loadSubmissions(); }
    catch { showLogin(); }
  }
  $('loginForm').addEventListener('submit', async event => {
    event.preventDefault(); $('loginError').textContent = ''; $('loginButton').disabled = true;
    try { await api('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) }); $('password').value = ''; showDashboard(); await loadSubmissions(); }
    catch (err) { $('loginError').textContent = err.message; }
    finally { $('loginButton').disabled = false; }
  });
  $('logoutButton').addEventListener('click', async () => { try { await api('/api/admin/logout', { method: 'POST' }); } catch {} showLogin(); });
  $('refreshButton').addEventListener('click', loadSubmissions);
  $('searchInput').addEventListener('input', render); $('consentFilter').addEventListener('change', render);
  checkSession();
})();
