/* Albus Language Center — сайтын JS */

/* ---------- Header ---------- */
const header = document.getElementById('header');
const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 40);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

/* ---------- Mobile menu ---------- */
const toggle = document.getElementById('menuToggle');
const closeMenu = () => {
  document.body.classList.remove('menu-open');
  toggle.setAttribute('aria-expanded', 'false');
};
toggle.addEventListener('click', () => {
  const open = document.body.classList.toggle('menu-open');
  toggle.setAttribute('aria-expanded', String(open));
});
document.querySelectorAll('#navbar a').forEach((a) => a.addEventListener('click', closeMenu));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

/* ---------- Reveal on scroll ---------- */
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  /* Active nav link */
  const links = [...document.querySelectorAll('#navbar a')];
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        links.forEach((l) => l.classList.toggle('active', l.getAttribute('href') === '#' + e.target.id));
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  links.forEach((l) => {
    const sec = document.querySelector(l.getAttribute('href'));
    if (sec) spy.observe(sec);
  });
} else {
  document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
}

/* ---------- Бүртгэлийн маягт ---------- */
const form = document.getElementById('register');
const courseSelect = document.getElementById('fcourse');
const submitBtn = document.getElementById('submitBtn');
const note = document.getElementById('formNote');
const defaultNote = note.textContent;

document.querySelectorAll('[data-course]').forEach((btn) =>
  btn.addEventListener('click', () => { courseSelect.value = btn.dataset.course; })
);

function setFieldError(name, message) {
  const slot = form.querySelector(`[data-err="${name}"]`);
  if (!slot) return;
  slot.textContent = message || '';
  slot.closest('.field').classList.toggle('invalid', Boolean(message));
}

function clearErrors() {
  form.querySelectorAll('[data-err]').forEach((el) => setFieldError(el.dataset.err, ''));
}

function clientValidate(data) {
  const errors = {};
  if (data.name.trim().length < 2) errors.name = 'Нэрээ оруулна уу.';
  const digits = data.phone.replace(/[\s\-().]/g, '').replace(/^\+?976(?=\d{8}$)/, '');
  if (!/^[1-9]\d{7}$/.test(digits)) errors.phone = '8 оронтой утасны дугаар оруулна уу.';
  return errors;
}

form.querySelectorAll('input, select, textarea').forEach((el) =>
  el.addEventListener('input', () => setFieldError(el.name, ''))
);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors();

  const data = Object.fromEntries(new FormData(form));
  const errors = clientValidate(data);
  if (Object.keys(errors).length) {
    Object.entries(errors).forEach(([k, v]) => setFieldError(k, v));
    form.querySelector('.field.invalid input')?.focus();
    return;
  }

  submitBtn.disabled = true;
  note.textContent = 'Илгээж байна…';
  note.style.color = '';

  try {
    const res = await fetch('/api/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({}));

    if (res.ok) {
      document.getElementById('successText').textContent = body.duplicate
        ? 'Таны хүсэлт өмнө нь бүртгэгдсэн байна. Бид удахгүй холбогдоно.'
        : `“${data.course}” сургалтад бүртгүүлэх хүсэлтийг хүлээн авлаа. Бид удахгүй тантай холбогдоно.`;
      form.classList.add('done');
      form.reset();
      note.textContent = defaultNote;
      return;
    }
    if (res.status === 422 && body.fields) {
      Object.entries(body.fields).forEach(([k, v]) => setFieldError(k, v));
      note.textContent = body.error || 'Мэдээллээ шалгана уу.';
    } else {
      note.textContent = body.error || 'Алдаа гарлаа. Дахин оролдоно уу.';
    }
    note.style.color = '#e8a87c';
  } catch {
    note.textContent = 'Сүлжээний алдаа. 9560 6825 дугаарт залгаж бүртгүүлэх боломжтой.';
    note.style.color = '#e8a87c';
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById('againBtn').addEventListener('click', () => {
  form.classList.remove('done');
  document.getElementById('fname').focus();
});
