import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} متوقف شد (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`));
    });
  });
}

function promptHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('برای ورود امن Access Token، دستور را در ترمینال تعاملی Termux اجرا کن.'));
  }
  return new Promise((resolvePrompt, rejectPrompt) => {
    let value = '';
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (error) {
        value = '';
        rejectPrompt(error);
        return;
      }
      const cleaned = value.replace(/\x1b?\[200~/g, '').replace(/\x1b?\[201~/g, '').trim();
      value = '';
      resolvePrompt(cleaned);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') return finish(new Error('عملیات لغو شد.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ' && character <= '~') {
          value += character;
          process.stdout.write('•');
        }
      }
    };
    process.stdout.write(question);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  process.chdir(root);
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supported = major === 20 && minor >= 19 || major === 22 && minor >= 12 || major > 22;
  if (!supported) throw new Error('Node.js نسخه 20.19+ یا 22.12+ لازم است. در Termux از nodejs-lts استفاده کن.');

  console.log('\nراه‌اندازی TRON Lab v2.8.7 · Indexed Watch-only Matching');
  console.log('تولید کلید خصوصی به‌صورت محلی در Worker انجام می‌شود؛ Backend برای تولید استفاده نمی‌شود.');

  // Check every tool required by setup/validate, including Vitest.
  // A previous partial or production-only install may contain Vite and
  // TypeScript while omitting the test runner.
  const required = [
    'node_modules/.bin/vite',
    'node_modules/.bin/tsc',
    'node_modules/.bin/vitest',
    'node_modules/react/package.json',
    'node_modules/@tgcloud/cli/package.json',
    'node_modules/vitest/package.json',
  ];
  if (!required.every((item) => existsSync(resolve(root, item)))) {
    // Explicitly include devDependencies so npm config/NODE_ENV settings
    // cannot silently omit Vitest and the other build tools.
    await run(npm, ['install', '--include=dev', '--no-audit', '--no-fund']);
  }

  const missing = required.filter((item) => !existsSync(resolve(root, item)));
  if (missing.length > 0) {
    throw new Error(
      `وابستگی‌های ضروری نصب نشده‌اند: ${missing.join(', ')}. ` +
      'اتصال اینترنت و فضای خالی دستگاه را بررسی کن، سپس داخل پوشه پروژه ' +
      'دستور npm install --include=dev را اجرا کن.'
    );
  }

  // tgcloud.jsonc is the project marker. A project may legitimately have no
  // .tgcloud state directory yet (for example, after extracting a clean ZIP).
  // Running init in that case is incorrect: the CLI detects the existing
  // project config and may refuse because the folder is already nested.
  const hasTgcloudProject = [
    '.tgcloud', 'tgcloud.jsonc', 'tgcloud.json', 'tgcloud.yaml', 'tgcloud.yml',
  ].some((marker) => existsSync(resolve(root, marker)));

  if (!hasTgcloudProject) {
    console.log('پروژه Telegram Serverless پیدا نشد؛ ساخت پروژه جدید...');
    await run(npm, ['exec', '--', 'tgcloud', 'init']);
  } else {
    console.log('پروژه Telegram Serverless موجود شناسایی شد؛ از اجرای دوباره tgcloud init صرف‌نظر شد.');
  }

  // npm 11+ blocks dependency install scripts unless allowScripts approves
  // them. esbuild needs its postinstall to prepare the platform binary used
  // by Vite. Only esbuild is approved in package.json; do not approve all.
  console.log('\nآماده‌سازی باینری esbuild برای دستگاه فعلی...');
  await run(npm, ['rebuild', 'esbuild']);

  console.log('\n۱/۳ اجرای تست‌های خودکار و ساخت نسخه Production');
  await run(npm, ['run', 'validate']);

  let token = await promptHidden('\nTelegram Serverless CLI Access Token را Paste کن: ');
  if (!/^app\d+:.+$/.test(token)) {
    token = '';
    throw new Error('قالب Access Token معتبر نیست؛ باید شبیه app123:secret باشد، نه Bot Token.');
  }

  const appId = token.match(/^app(\d+):/)?.[1];
  const appUrl = appId ? `https://app${appId}.tgcloud.ai/` : '';
  const authenticatedEnv = { ...process.env, TGCLOUD_TOKEN: token };
  token = '';

  try {
    // Synchronize the local CLI revision with the currently deployed project.
    // `fetch` does not overwrite local files.
    console.log('\n۲/۳ دریافت وضعیت Deployment فعلی بدون تغییر فایل‌های محلی');
    await run(npm, ['exec', '--', 'tgcloud', 'fetch'], authenticatedEnv);

    // IMPORTANT: do not run a full `tgcloud push` here. The cloud already has
    // legacy backend modules. A full push mirrors the local tgcloud/ tree and
    // would delete remote modules that are absent in this Local-first app.
    // A targeted static push updates only dist/ and never deletes modules.
    console.log('\n۳/۳ انتشار فقط فایل‌های Mini App (dist/)؛ ماژول‌های Backend حفظ می‌شوند');
    await run(npm, ['exec', '--', 'tgcloud', 'push', 'dist/'], authenticatedEnv);
  } finally {
    authenticatedEnv.TGCLOUD_TOKEN = '';
  }

  console.log('\nراه‌اندازی تمام شد.');
  if (appUrl) console.log(`آدرس Mini App: ${appUrl}`);
  console.log('ماژول‌های Backend قبلی با این انتشار استاتیک تغییر یا حذف نشدند.');
  console.log('اگر دکمه منوی ربات قبلاً تنظیم شده باشد، همان آدرس Mini App را باز می‌کند.');
  console.log('اگر هنوز تنظیم نشده، در @BotFather دستور /setmenubutton را اجرا و آدرس بالا را ثبت کن.');
  console.log('Seedها و کلیدهای خصوصی روی سرور ارسال نمی‌شوند.');
  console.log('Access Token در سورس یا فایل تنظیمات ذخیره نشد.');
}

main().catch((error) => {
  console.error(`\nخطا: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
