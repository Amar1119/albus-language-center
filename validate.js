/** Сургалтын жагсаалт — нэг газраас удирдана (сайт, API, админ). */
export const COURSES = Object.freeze([
  'Англи хэл',
  'IELTS',
  'SAT',
  'Герман хэл',
  'Орос хэл',
  'Хятад хэл',
  'Солонгос хэл',
]);

export const STATUSES = Object.freeze(['new', 'contacted', 'enrolled', 'cancelled']);

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function cleanText(value, { multiline = false } = {}) {
  let s = String(value ?? '').normalize('NFC').replace(CONTROL_CHARS, '');
  s = multiline
    ? s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Монгол дугаар: 8 оронтой, +976 / 976 угтвартай байж болно. */
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/[\s\-().]/g, '');
  if (d.startsWith('+976')) d = d.slice(4);
  else if (d.startsWith('976') && d.length === 11) d = d.slice(3);
  return /^[1-9]\d{7}$/.test(d) ? d : null;
}

export function validateRegistration(body) {
  const errors = {};
  const src = body && typeof body === 'object' ? body : {};

  const name = cleanText(src.name);
  if (name.length < 2) errors.name = 'Нэрээ оруулна уу.';
  else if (name.length > 80) errors.name = 'Нэр хэт урт байна.';

  const phone = normalizePhone(src.phone);
  if (!phone) errors.phone = '8 оронтой утасны дугаар оруулна уу.';

  const course = cleanText(src.course);
  if (!COURSES.includes(course)) errors.course = 'Сургалтаа сонгоно уу.';

  const message = cleanText(src.message, { multiline: true });
  if (message.length > 500) errors.message = 'Нэмэлт мэдээлэл 500 тэмдэгтээс хэтрэхгүй.';

  return Object.keys(errors).length
    ? { ok: false, errors }
    : { ok: true, value: { name, phone, course, message } };
}

export function validateUpdate(body) {
  const src = body && typeof body === 'object' ? body : {};
  const patch = {};
  if (src.status !== undefined) {
    if (!STATUSES.includes(src.status)) return { ok: false, error: 'Буруу төлөв.' };
    patch.status = src.status;
  }
  if (src.admin_note !== undefined) {
    const note = cleanText(src.admin_note, { multiline: true });
    if (note.length > 1000) return { ok: false, error: 'Тэмдэглэл хэт урт.' };
    patch.admin_note = note;
  }
  if (!Object.keys(patch).length) return { ok: false, error: 'Өөрчлөх зүйл алга.' };
  return { ok: true, value: patch };
}
