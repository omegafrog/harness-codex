import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / "bin" / "plantuml-render.mjs"
BOOTSTRAP = ROOT / "bin" / "plantuml-bootstrap.mjs"


class PlantUmlToolsTest(unittest.TestCase):
    def run_renderer(self, *args, env=None):
        return subprocess.run(
            ["node", str(RENDERER), *map(str, args)],
            cwd=ROOT, text=True, capture_output=True, env=env, check=False,
        )

    def test_rejects_include_outside_workspace_before_java(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "diagram.puml"
            source.write_text("@startuml\n!include /etc/passwd\n@enduml\n")
            result = self.run_renderer("--workspace", root, "--jar", root / "plantuml.jar", source)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("!include", result.stderr)
            self.assertIn("workspace", result.stderr.lower())

    def test_renders_svg_and_optional_png_with_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "diagram.puml"
            jar = root / "plantuml.jar"
            source.write_text("@startuml\nAlice -> Bob: hello\n@enduml\n")
            jar.write_bytes(b"fake jar")
            fake_java = root / "java"
            fake_java.write_text(
                "#!/bin/sh\n"
                "[ \"$1\" = -version ] && exit 0\n"
                "out=''\n"
                "for arg in \"$@\"; do [ \"$arg\" = -o ] && next=1 && continue; "
                "[ \"$next\" = 1 ] && out=\"$arg\" && next=0; done\n"
                "mkdir -p \"$out\"\n"
                "printf '<svg>ok</svg>' > \"$out/diagram.svg\"\n"
                "printf 'png' > \"$out/diagram.png\"\n"
            )
            fake_java.chmod(0o755)
            environment = os.environ | {"PATH": f"{root}:{os.environ['PATH']}"}
            result = self.run_renderer(
                "--workspace", root, "--jar", jar, "--png", source, env=environment
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((root / "diagram.svg").read_text().startswith("<svg>"))
            self.assertTrue((root / "diagram.png").exists())

    def test_reports_missing_jar_without_installing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "diagram.puml"
            source.write_text("@startuml\nAlice -> Bob\n@enduml\n")
            result = self.run_renderer("--workspace", root, "--jar", root / "missing.jar", source)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("bootstrap", result.stderr.lower())

    def test_rejects_jar_checksum_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "diagram.puml"
            jar = root / "plantuml.jar"
            source.write_text("@startuml\nAlice -> Bob\n@enduml\n")
            jar.write_bytes(b"fake jar")
            result = self.run_renderer(
                "--workspace", root, "--jar", jar, "--sha256", "0" * 64, source
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("SHA-256 mismatch", result.stderr)

    def test_bootstrap_verifies_download_checksum(self):
        self.assertTrue(BOOTSTRAP.exists())
        self.assertIn("sha256", BOOTSTRAP.read_text(encoding="utf-8").lower())


if __name__ == "__main__":
    unittest.main()
