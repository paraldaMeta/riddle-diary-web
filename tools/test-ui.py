from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8787"
OUT = Path(".wrangler/ui-tests")
OUT.mkdir(parents=True, exist_ok=True)


def check_view(browser, name, viewport, standalone=False):
    context = browser.new_context(viewport=viewport, device_scale_factor=2 if standalone else 1)
    if standalone:
        context.add_init_script("Object.defineProperty(navigator, 'standalone', {get: () => true});")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("#guide .title", timeout=10000)

    loaded_wenkai_faces = page.evaluate(
        """async () => (await document.fonts.load(
          '20px "LXGW WenKai Lite"',
          '地占答案会辨认财富、事业、感情与未来。'
        )).length"""
    )
    assert loaded_wenkai_faces > 0

    title_lines = page.locator("#guide .title span").all_text_contents()
    assert title_lines == ["The Geomancer’s", "Book of Answers"]
    assert page.locator("#guide .gestures").count() == 0
    assert page.locator("#install-app").is_hidden() if standalone else page.locator("#install-app").is_visible()
    assert page.locator("text=API 密钥").count() == 0
    canvas_box = page.locator("#paper").bounding_box()
    assert abs(canvas_box["width"] - viewport["width"]) < 1
    assert abs(canvas_box["height"] - viewport["height"]) < 1

    # Anonymous visitors are guided into registration automatically after the
    # book title has had time to appear and begin fading away.
    page.wait_for_selector("#portal-root.portal-open.portal-auth-scene", timeout=5000)
    page.wait_for_selector('input[name="email"]')
    page.wait_for_timeout(2400)
    assert page.locator("text=先让我记住你。").count() == 1
    assert page.locator("#guide").evaluate("element => element.classList.contains('hidden')")
    email = page.locator('input[name="email"]')
    password = page.locator('input[name="password"]')
    email.fill("reader@example.com")
    password.fill("a-secure-test-password")
    assert email.input_value() == "reader@example.com"
    assert password.input_value() == "a-secure-test-password"
    drawer_box = page.locator(".portal-drawer").bounding_box()
    assert drawer_box["x"] >= -1 and drawer_box["y"] >= -1
    assert drawer_box["width"] <= viewport["width"] + 1
    assert drawer_box["height"] <= viewport["height"] + 1
    page.screenshot(path=str(OUT / f"{name}-register.png"), full_page=True)

    page.locator('[data-auth-mode="otp"]').click()
    page.wait_for_selector('input[name="email"]')
    assert page.locator("text=发送登录验证码").count() == 1
    page.locator(".portal-close").click()
    page.wait_for_selector("#portal-root:not(.portal-open)")
    page.wait_for_timeout(350)

    if standalone:
        page.mouse.move(80, 210)
        page.mouse.down()
        page.mouse.move(250, 210, steps=12)
        page.mouse.up()
        aligned_ink_alpha = page.evaluate(
            """() => {
              const canvas = document.querySelector('#paper');
              const rect = canvas.getBoundingClientRect();
              const scaleX = canvas.width / rect.width;
              const scaleY = canvas.height / rect.height;
              const pixels = canvas.getContext('2d').getImageData(
                Math.round(155 * scaleX), Math.round(205 * scaleY),
                Math.max(1, Math.round(10 * scaleX)), Math.max(1, Math.round(10 * scaleY))
              ).data;
              let alpha = 0;
              for (let index = 3; index < pixels.length; index += 4) alpha = Math.max(alpha, pixels[index]);
              return alpha;
            }"""
        )
        assert aligned_ink_alpha > 50

    page.screenshot(path=str(OUT / f"{name}-book.png"), full_page=True)

    allowed_network_errors = ("Failed to load resource", "net::ERR", "WebGL")
    fatal = [error for error in errors if not any(item in error for item in allowed_network_errors)]
    assert not fatal, fatal
    context.close()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    check_view(browser, "desktop", {"width": 1440, "height": 900})
    check_view(browser, "ios-pwa", {"width": 390, "height": 844}, standalone=True)
    browser.close()

print("ui: desktop and iOS standalone registration scene, WenKai coverage, keyboard fields and ink coordinates passed")
