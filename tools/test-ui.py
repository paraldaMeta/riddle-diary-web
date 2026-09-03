import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ.get("TEST_BASE_URL", "http://localhost:8787").rstrip("/")
OUT = Path(".wrangler/ui-tests")
OUT.mkdir(parents=True, exist_ok=True)


def check_view(browser, name, viewport, locale, standalone=False):
    context = browser.new_context(
        viewport=viewport,
        locale=locale,
        device_scale_factor=2 if standalone else 1,
    )
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

    document_locale = page.evaluate("() => document.documentElement.lang")
    title_lines = page.locator("#guide .title span").all_text_contents()
    if document_locale == "en":
        assert title_lines == ["The Geomancer’s", "Book of Answers"]
        auth_prompt = "Who are you?"
        otp_submit = "Send sign-in code"
    else:
        assert title_lines == ["地占解答书"]
        auth_prompt = "你是谁。"
        otp_submit = "发送登录验证码"
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
    assert page.locator(f"text={auth_prompt}").count() == 1
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
    assert page.locator(f"text={otp_submit}").count() == 1
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


def check_recovery(browser):
    context = browser.new_context(viewport={"width": 900, "height": 700}, locale="zh-CN")
    page = context.new_page()
    request_ids = []

    def handle_api(route):
        if route.request.url.endswith("/api/auth/me"):
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "user": {"email": "reader@example.com", "credits": 3, "admin": False},
                    "config": {"auth": {"turnstileSiteKey": ""}, "billing": {"enabled": False, "packages": []}},
                }),
            )
            return
        if route.request.url.endswith("/api/ask"):
            request_ids.append(route.request.post_data_json["requestId"])
            route.fulfill(
                status=422,
                content_type="application/json",
                body=json.dumps({
                    "code": "HANDWRITING_UNREADABLE",
                    "error": "图片中的手写文字无法准确辨认。",
                }),
            )
            return
        route.continue_()

    page.route("**/api/**", handle_api)
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("#paper", timeout=10000)
    page.mouse.move(120, 220)
    page.mouse.down()
    page.mouse.move(300, 220, steps=14)
    page.mouse.up()
    page.wait_for_selector("#status.status-recovery", timeout=10000)
    assert page.locator("[data-status-action]").count() == 3
    assert len(request_ids) == 1

    page.locator('[data-status-action="write"]').click()
    page.wait_for_timeout(3200)
    assert len(request_ids) == 1

    page.locator('[data-status-action="erase"]').click()
    page.mouse.click(210, 220)
    page.locator('[data-status-action="write"]').click()
    page.wait_for_timeout(4600)
    assert len(request_ids) == 2
    assert request_ids[0] != request_ids[1]
    context.close()


def check_short_auth(browser):
    context = browser.new_context(viewport={"width": 1016, "height": 254}, locale="zh-CN")
    page = context.new_page()
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("#portal-root.portal-open.portal-auth-scene", timeout=7000)
    page.wait_for_timeout(2200)

    body_box = page.locator(".portal-body").bounding_box()
    prompt_box = page.locator(".portal-auth-prologue").bounding_box()
    auth_switch_box = page.locator(".portal-auth-switch").bounding_box()
    assert body_box["height"] > 0
    assert prompt_box["y"] < body_box["y"] + body_box["height"]
    assert auth_switch_box["y"] < body_box["y"] + body_box["height"]
    assert page.locator(".portal-body").evaluate("element => element.scrollHeight > element.clientHeight")
    context.close()


def check_sound_returns_to_sidebar(browser):
    for viewport in ({"width": 390, "height": 844}, {"width": 1440, "height": 900}):
        context = browser.new_context(viewport=viewport, locale="zh-CN")
        page = context.new_page()
        page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#portal-root.portal-open.portal-auth-scene", timeout=7000)
        page.locator('.portal-nav [data-section="sound"]').click()
        page.wait_for_selector("#portal-root.portal-open:not(.portal-auth-scene)", timeout=3000)
        page.wait_for_selector("#portal-track-title", timeout=3000)
        assert page.locator("#guide").evaluate("element => !element.classList.contains('hidden')")
        drawer_box = page.locator(".portal-drawer").bounding_box()
        if viewport["width"] <= 640:
            assert drawer_box["y"] > 0
            assert drawer_box["height"] < viewport["height"]
        else:
            assert drawer_box["x"] >= viewport["width"] - 521
            assert drawer_box["width"] <= 520
        context.close()


def check_auth_network_error(browser):
    context = browser.new_context(viewport={"width": 900, "height": 700}, locale="zh-CN")
    page = context.new_page()

    def handle_api(route):
        if route.request.url.endswith("/api/auth/me"):
            route.abort(error_code="failed")
            return
        route.continue_()

    page.route("**/api/**", handle_api)
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("#portal-root.portal-open.portal-auth-scene", timeout=7000)
    page.wait_for_selector("#portal-auth-message", timeout=5000)
    assert page.locator("#portal-auth-message").inner_text() == "网络连接失败，地占解答书暂时无法回应。"
    assert page.locator("[data-auth-retry]").count() == 1
    assert page.locator("#portal-auth-form [type=submit]").is_disabled()
    context.close()


def check_origin_story(browser):
    context = browser.new_context(viewport={"width": 900, "height": 700}, locale="zh-CN")
    context.add_init_script(
        "window.turnstile = {render: (host, options) => { setTimeout(() => options.callback('dev-test'), 0); return 'test-widget'; }, remove: () => {}};"
    )
    page = context.new_page()

    def handle_api(route):
        url = route.request.url
        if "challenges.cloudflare.com" in url:
            route.abort()
            return
        if url.endswith("/api/auth/me"):
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "user": None,
                    "config": {
                        "auth": {"turnstileSiteKey": "test-site-key"},
                        "billing": {"enabled": False, "packages": []},
                    },
                }),
            )
            return
        if url.endswith("/api/auth/register"):
            route.fulfill(
                status=202,
                content_type="application/json",
                body=json.dumps({"challengeId": "otp_test", "message": "验证码已经寄出"}),
            )
            return
        if url.endswith("/api/auth/otp/verify"):
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "user": {"email": "reader@example.com", "credits": 3, "admin": False},
                }),
            )
            return
        route.continue_()

    page.route("**/*", handle_api)
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("#portal-root.portal-open.portal-auth-scene", timeout=7000)
    page.locator('input[name="email"]').fill("reader@example.com")
    page.locator('input[name="password"]').fill("a-secure-test-password")
    page.locator('#portal-auth-form button[type="submit"]').click()
    page.wait_for_selector('input[name="code"]', timeout=5000)
    page.locator('input[name="code"]').fill("123456")
    page.locator('#portal-code-form button[type="submit"]').click()
    page.wait_for_selector('[data-close-portal]', timeout=5000)
    assert page.locator("text=那么，我也该告诉你一件事。").count() == 1
    assert page.locator("text=Fortuna Major").count() == 1
    page.locator("[data-close-portal]").click()
    page.wait_for_selector("#portal-root:not(.portal-open)")
    context.close()


def check_membership(browser):
    context = browser.new_context(viewport={"width": 900, "height": 700}, locale="zh-CN")
    page = context.new_page()

    def handle_api(route):
        if route.request.url.endswith("/api/auth/me"):
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "user": {
                        "email": "advanced@example.com",
                        "credits": 0,
                        "admin": False,
                        "membership": {
                            "planId": "advanced_monthly",
                            "tier": "advanced",
                            "interval": "month",
                            "status": "active",
                            "cancelAtPeriodEnd": False,
                            "quota": 50,
                            "used": 3,
                            "refunded": 0,
                            "remaining": 47,
                            "periodStartsAt": 1700000000,
                            "periodEndsAt": 1800000000,
                        },
                    },
                    "config": {
                        "auth": {"turnstileSiteKey": ""},
                        "billing": {
                            "enabled": True,
                            "premiumAnimations": {
                                "lumos": "/assets/premium/lumos-quill.mp4",
                                "map": "/assets/premium/map-ink-footsteps.mp4",
                                "flourish": "/assets/premium/golden-flight.mp4",
                            },
                            "memberships": [
                                {"id": "basic_monthly", "tier": "basic", "interval": "month", "amount": 1900, "credits": 20},
                                {"id": "advanced_monthly", "tier": "advanced", "interval": "month", "amount": 4900, "credits": 50},
                            ],
                        },
                    },
                }),
            )
            return
        if route.request.url.endswith("/api/ask"):
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "text": "答案已经在墨迹中显现。",
                    "remainingCredits": 0,
                    "membership": {
                        "planId": "advanced_monthly",
                        "tier": "advanced",
                        "interval": "month",
                        "status": "active",
                        "cancelAtPeriodEnd": False,
                        "quota": 50,
                        "used": 4,
                        "refunded": 0,
                        "remaining": 46,
                        "periodStartsAt": 1700000000,
                        "periodEndsAt": 1800000000,
                    },
                }),
            )
            return
        route.continue_()

    page.route("**/api/**", handle_api)
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.locator("#account-button").click()
    page.wait_for_selector("#portal-root.portal-open", timeout=5000)
    page.wait_for_selector("text=高级会员", timeout=5000)
    page.wait_for_function("() => document.body.classList.contains('premium-member')")
    assert page.locator("[data-manage-subscription]").count() == 1
    assert page.locator("#premium-light").get_attribute("hidden") is None
    assert page.locator("#premium-animation").get_attribute("src") == "/assets/premium/lumos-quill.mp4"
    page.locator(".portal-close").click()
    page.wait_for_selector("#portal-root:not(.portal-open)")
    page.mouse.move(160, 180)
    page.mouse.down()
    page.mouse.move(360, 240, steps=8)
    page.mouse.up()
    page.wait_for_function(
        "() => { const source = document.querySelector('#premium-animation').getAttribute('src'); return source && source.endsWith('/map-ink-footsteps.mp4'); }",
        timeout=12000,
    )
    page.locator("#premium-animation").evaluate("video => video.dispatchEvent(new Event('ended'))")
    page.wait_for_function(
        "() => { const source = document.querySelector('#premium-animation').getAttribute('src'); return source && source.endsWith('/golden-flight.mp4'); }",
        timeout=2000,
    )
    page.locator("#premium-animation").evaluate("video => video.dispatchEvent(new Event('ended'))")
    page.wait_for_function("() => document.querySelector('#premium-light').hasAttribute('hidden')", timeout=3000)
    assert page.locator("#account-button").get_attribute("data-credit") == "46"
    context.close()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    check_view(browser, "desktop-en", {"width": 1440, "height": 900}, "en-US")
    check_view(browser, "desktop-zh", {"width": 1440, "height": 900}, "zh-CN")
    check_view(browser, "ios-pwa-en", {"width": 390, "height": 844}, "en-US", standalone=True)
    check_view(browser, "ios-pwa-zh", {"width": 390, "height": 844}, "zh-CN", standalone=True)
    check_short_auth(browser)
    check_sound_returns_to_sidebar(browser)
    check_auth_network_error(browser)
    check_recovery(browser)
    check_origin_story(browser)
    check_membership(browser)
    browser.close()

print("ui: English and Chinese desktop/iOS registration scenes, WenKai coverage, keyboard fields and ink coordinates passed")
