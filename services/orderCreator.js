/**
 * orderCreator.js
 * Tạo đơn GHN bằng cách connect Playwright vào Chrome thật qua CDP.
 *
 * FLOW:
 * 1. openBrowserForLogin() → mở Chrome với profile riêng ~/ChromeGHN
 *    User đăng nhập 1 lần → session lưu trong profile đó
 * 2. createOrder()         → connectOverCDP vào Chrome đang chạy → fill form → submit
 *    Không cần login lại vì session đã có trong profile
 *
 * LƯU Ý: Dùng thư mục profile RIÊNG (~/ChromeGHN) để tránh conflict
 * với Chrome đang chạy bình thường của user.
 */
import { chromium } from 'playwright'
import { spawn } from 'child_process'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP_PORT = 9223
const CDP_URL = `http://localhost:${CDP_PORT}`

// Thư mục profile RIÊNG cho GHN automation (tránh conflict với Chrome bình thường)
const GHN_PROFILE_DIR = `${process.env.HOME}/Library/Application Support/ChromeGHN`

const URLS = {
  test: 'https://5sao.ghn.dev',
  prod: 'https://khachhang.ghn.vn',
}

let chromeProcess = null

/**
 * Kiểm tra Chrome đang chạy với CDP port chưa
 */
async function isChromeRunning() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Kill Chrome đang dùng profile GHN (nếu có)
 */
async function killExistingChrome() {
  return new Promise(resolve => {
    const kill = spawn('pkill', ['-f', 'ChromeGHN'], { stdio: 'ignore' })
    kill.on('close', () => resolve())
    setTimeout(resolve, 1000)
  })
}

/**
 * Mở Chrome với profile GHN riêng + CDP port
 */
async function launchChrome(env = 'test') {
  if (await isChromeRunning()) return // đã chạy rồi

  // Tạo thư mục profile nếu chưa có
  try { mkdirSync(GHN_PROFILE_DIR, { recursive: true }) } catch {}

  chromeProcess = spawn(CHROME_BIN, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${GHN_PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    URLS[env],
  ], { detached: false, stdio: 'ignore' })

  chromeProcess.on('error', err => console.error('[Chrome] spawn error:', err.message))

  // Chờ Chrome khởi động + CDP bind (tối đa 12s)
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (await isChromeRunning()) return
  }
  throw new Error('Chrome không khởi động được (CDP timeout 12s)')
}

/**
 * openBrowserForLogin(environment)
 * Mở Chrome với profile GHN riêng → user đăng nhập → session lưu.
 */
export async function openBrowserForLogin(environment = 'test') {
  try {
    // Kill Chrome GHN cũ nếu đang chạy (để tránh conflict)
    await killExistingChrome()
    await new Promise(r => setTimeout(r, 500))

    await launchChrome(environment)
    return {
      ok: true,
      message: `Chrome đã mở tại ${URLS[environment]} (profile GHN riêng). Đăng nhập xong, session sẽ lưu tự động.`,
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * createOrder(data, environment)
 * Connect vào Chrome đang chạy qua CDP → tạo đơn hàng.
 */
export async function createOrder(data, environment = 'test') {
  return createOrderImpl(data, environment === 'prod' ? 'prod' : 'test')
}

async function createOrderImpl(data, env) {
  // Đảm bảo Chrome đang chạy
  if (!(await isChromeRunning())) {
    await launchChrome(env)
    await new Promise(r => setTimeout(r, 3000))
  }

  let browser, page
  try {
    // Connect vào Chrome thật qua CDP
    browser = await chromium.connectOverCDP(CDP_URL)

    const context = browser.contexts()[0] || await browser.newContext()

    // Dùng tab GHN đang mở — React đã load sẵn, SPA route change nhanh hơn
    const allPages = context.pages()
    page = allPages.find(p => p.url().includes('5sao.ghn.dev') && !p.url().includes('devtools'))
    if (!page) page = await context.newPage()

    // Navigate đến trang tạo đơn
    await page.goto(`${URLS[env]}/order/create/2`, { waitUntil: 'domcontentloaded', timeout: 30000 })

    // Chờ React render form
    await page.waitForFunction(
      () => document.querySelectorAll('input[name="to_phone"]').length > 0,
      { timeout: 20000 }
    )

    // Kiểm tra đã đăng nhập chưa
    const url = page.url()
    if (url.includes('sso.ghn') || url.includes('/login') || url.includes('/signin') || url.includes('/auth') || !url.includes('5sao.ghn')) {
      await page.close()
      return {
        success: false,
        error: 'Chưa đăng nhập. Vui lòng bấm "Mở browser đăng nhập" và đăng nhập vào GHN trước.',
      }
    }

    await fillOrderForm(page, data, env)

    // Click submit button
    try {
      await page.click(
        'button[type="submit"], button:has-text("Tạo đơn"), button:has-text("Lưu"), button:has-text("Tạo mới")',
        { timeout: 5000 }
      )
    } catch {
      const btn = await page.$('button:not([disabled])')
      if (btn) await btn.click()
    }

    const orderCode = await waitForOrderCode(page)

    // Chụp screenshot để debug
    await page.screenshot({ path: '/tmp/ghn_after_submit.png' }).catch(() => {})
    console.log('[createOrder] URL after submit:', page.url(), '| orderCode:', orderCode)

    // Đóng tab automation sau khi xong (không close Chrome)
    await page.close().catch(() => {})

    if (orderCode) return { success: true, order_code: orderCode }
    return { success: false, error: 'Không lấy được mã đơn sau khi submit' }

  } catch (err) {
    // Giữ tab lại khi lỗi để debug — KHÔNG close
    console.error('[createOrder] error:', err.message)
    return { success: false, error: err.message }
  } finally {
    // Chỉ disconnect khỏi CDP, KHÔNG close Chrome
    if (browser) await browser.close().catch(() => {})
  }
}

// ── Form filling ──────────────────────────────────────────────────────────────

async function fillOrderForm(page, data, env) {
  // Dùng page.fill() để trigger React synthetic events đúng cách
  const fill = async (selector, value) => {
    if (value === undefined || value === null || String(value).trim() === '') return
    try {
      await page.click(selector, { timeout: 3000 })
      await page.fill(selector, String(value))
    } catch {}
  }

  await fill('input[name="to_phone"]', data['Số điện thoại'])
  await fill('input[name="to_name"]', data['Tên người nhận'])
  await fill('input[name="name"]', data['Sản phẩm'])
  await fill('input[name="cod_amount"]', data['Tiền thu hộ'])
  await fill('input[name="insurance_value"]', data['Giá trị hàng hoá'])
  await fill('textarea[name="note"]', data['Ghi chú thêm'])

  // Khối lượng — input đầu tiên placeholder "khối lượng"
  try {
    const weightEls = await page.$$('input[name="weight"]')
    for (const el of weightEls) {
      const ph = (await el.getAttribute('placeholder')) || ''
      if (ph.toLowerCase().includes('kh') && await el.isVisible()) {
        await el.click()
        await el.fill(String(data['Khối lượng (Gram)'] || ''))
        break
      }
    }
  } catch {}

  await fill('input[name="length"]', data['Dài'])
  await fill('input[name="width"]', data['Rộng'])
  await fill('input[name="height"]', data['Cao'])

  // Địa chỉ: click nút ">" để mở dialog chọn địa chỉ
  await fillAddress(page, data)
}

/**
 * Điền địa chỉ qua dialog (click ">" → chọn tỉnh/quận/phường → nhập số nhà)
 */
async function fillAddress(page, data) {
  try {
    // Click vùng địa chỉ để mở dialog/modal
    await page.click('[class*="address"], [placeholder*="địa chỉ người nhận" i], .address-input, button:has-text("Nhập địa chỉ")', { timeout: 3000 })
    await page.waitForTimeout(500)

    // Chờ dialog mở — tìm input trong dialog
    const dialogInput = await page.waitForSelector('.modal input, [role="dialog"] input, .address-modal input', { timeout: 5000 }).catch(() => null)

    if (!dialogInput) {
      // Thử selector khác — tìm input xuất hiện sau khi click
      const inputs = await page.$$('input[placeholder*="tỉnh" i], input[placeholder*="province" i]')
      if (inputs.length) {
        await inputs[0].fill(data['Tỉnh/Thành phố'] || '')
      }
      return
    }

    // Nếu có dialog, điền theo thứ tự
    const province = data['Tỉnh/Thành phố'] || ''
    const district = data['Quận/Huyện'] || ''
    const ward = data['Phường/Xã'] || ''
    const street = data['Số nhà, tên đường'] || ''

    await selectAddressOption(page, province)
    await page.waitForTimeout(600)
    await selectAddressOption(page, district)
    await page.waitForTimeout(600)
    await selectAddressOption(page, ward)
    await page.waitForTimeout(400)

    // Nhập số nhà
    const streetInput = await page.$('input[placeholder*="số nhà" i], input[placeholder*="tên đường" i], input[placeholder*="địa chỉ cụ thể" i]')
    if (streetInput) {
      await streetInput.click()
      await streetInput.fill(street)
    }
  } catch (e) {
    console.log('[fillAddress] error:', e.message)
  }
}

async function selectAddressOption(page, value) {
  if (!value) return
  try {
    // Click dropdown đang active rồi type để search
    const activeDropdown = await page.$('.rw-widget.rw-state-focus, .rw-dropdown-list:not(.rw-state-disabled)')
    if (activeDropdown) {
      await activeDropdown.click()
      await page.waitForTimeout(200)
    }
    await page.keyboard.type(value, { delay: 50 })
    await page.waitForTimeout(400)
    // Click option đầu tiên
    const option = await page.$('.rw-list-option, .dropdown-item, li[role="option"]')
    if (option) await option.click()
  } catch {}
}

// ── Wait for order code ───────────────────────────────────────────────────────

// Các từ khóa trong URL không phải order code
const URL_BLACKLIST = new Set(['CREATE', 'ORDER', 'EDIT', 'NEW', 'LIST', 'DETAIL', 'VIEW', 'SUCCESS', 'INFO', 'IMPORT'])

async function waitForOrderCode(page) {
  try {
    // Chờ URL rời khỏi trang /create/2 (navigate sang trang kết quả)
    await page.waitForFunction(
      () => !window.location.pathname.includes('/order/create'),
      { timeout: 20000 }
    ).catch(() => {})

    const url = page.url()

    // Chỉ parse URL nếu đã rời khỏi /create
    if (!url.match(/\/order\/create$/i)) {
      const urlMatch = url.match(/\/([A-Z0-9]{6,20})(?:[/?#]|$)/i)
      if (urlMatch) {
        const code = urlMatch[1].toUpperCase()
        if (!URL_BLACKLIST.has(code)) return code
      }
    }

    // Thử parse từ DOM
    for (const sel of ['[data-order-code]', '[class*="order-code"]', '.ant-result-title', '.success-code', 'h2', 'h3']) {
      try {
        const el = await page.$(sel)
        if (el) {
          const text = await el.textContent()
          const match = text?.match(/[A-Z0-9]{8,20}/)
          if (match && !URL_BLACKLIST.has(match[0])) return match[0]
        }
      } catch {}
    }
    return null
  } catch {
    return null
  }
}
