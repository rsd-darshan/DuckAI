import unittest

from fastapi.testclient import TestClient

from database import init_db
from main import app


class SmokeAPITest(unittest.TestCase):
    def setUp(self):
        init_db()
        self.client = TestClient(app)

    def test_health(self):
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json().get("status"), "ok")

    def test_meta(self):
        res = self.client.get("/api/meta")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data.get("app"), "sideai-backend")
        self.assertIn("features", data)
        self.assertIn("chat_stream", data["features"])
        self.assertIn("uptime_seconds", data)

    def test_integrations_flags(self):
        res = self.client.get("/api/integrations/flags")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("browser_bridge", data)
        self.assertIn("vscode_bridge", data)
        self.assertIn("macros", data)
        self.assertIn("team_collab", data)

    def test_quick_tools_catalog(self):
        res = self.client.get("/api/quick-tools/list")
        self.assertEqual(res.status_code, 200)
        items = res.json().get("items", [])
        self.assertTrue(len(items) > 10)

    def test_notifications_roundtrip(self):
        created = self.client.post("/api/notifications", json={"title": "Smoke test", "body": "hello", "level": "info"})
        self.assertEqual(created.status_code, 200)
        nid = created.json().get("id")
        self.assertTrue(bool(nid))
        listed = self.client.get("/api/notifications")
        self.assertEqual(listed.status_code, 200)
        self.assertTrue(any(item.get("id") == nid for item in listed.json().get("items", [])))

    def test_plugins_roundtrip(self):
        created = self.client.post("/api/plugins", json={"name": "smoke-plugin", "version": "0.0.1", "permissions": []})
        self.assertEqual(created.status_code, 200)
        pid = created.json().get("id")
        toggled = self.client.post(f"/api/plugins/{pid}/enabled", json={"enabled": False})
        self.assertEqual(toggled.status_code, 200)
        self.assertFalse(toggled.json().get("enabled"))

    def test_privacy_settings_persist_to_db(self):
        import json

        from database import get_settings

        res = self.client.post(
            "/api/privacy_settings",
            json={"blocked_apps": ["SmokeTestApp"], "redact_sensitive": False},
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json().get("blocked_apps"), ["SmokeTestApp"])
        self.assertFalse(res.json().get("redact_sensitive"))
        gs = get_settings()
        self.assertIn("privacy_blocked_apps", gs)
        apps = json.loads(gs["privacy_blocked_apps"]["value"])
        self.assertEqual(apps, ["SmokeTestApp"])
        self.assertEqual(gs["privacy_redact_sensitive"]["value"].lower(), "false")

    def test_type_text_requires_body(self):
        res = self.client.post("/api/type_text", json={"text": "   ", "method": "auto", "delay_seconds": 0})
        self.assertEqual(res.status_code, 400)


if __name__ == "__main__":
    unittest.main()
