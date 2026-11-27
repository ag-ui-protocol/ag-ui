"""The source-identity gate must fail for plausible misleading dependency graphs."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("consumer_verify", Path(__file__).with_name("verify.py"))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class SourceIdentityTests(unittest.TestCase):
    repo = "https://github.com/example/ag-ui.git"
    revision = "1" * 40

    def graph(self):
        source = f"git+{self.repo}?rev={self.revision}#{self.revision}"
        packages = [{"id": "root", "name": "consumer", "version": "0.0.0", "source": None}]
        packages += [{"id": name, "name": name, "version": "0.2.0", "source": source} for name in verify.SDK]
        nodes = [{"id": name, "deps": [{"pkg": "ag-ui-core"}]} for name in ("ag-ui-client", "ag-ui-encoder")]
        return {"packages": packages, "resolve": {"root": "root", "nodes": nodes}}

    def test_one_shared_git_core_passes(self):
        selected, duplicates = verify.check_sources(self.graph(), self.repo, self.revision)
        self.assertEqual(set(selected), set(verify.SDK))
        self.assertEqual(duplicates, {})

    def test_wrong_revision_is_not_a_pin(self):
        graph = self.graph()
        graph["packages"][1]["source"] = "git+https://github.com/example/ag-ui.git?branch=main#" + "2" * 40
        with self.assertRaises(AssertionError):
            verify.check_sources(graph, self.repo, self.revision)

    def test_registry_core_duplicate_is_rejected(self):
        graph = self.graph()
        duplicate = copy.deepcopy(graph["packages"][1])
        duplicate.update(id="registry-core", source="registry+https://github.com/rust-lang/crates.io-index")
        graph["packages"].append(duplicate)
        with self.assertRaises(AssertionError):
            verify.check_sources(graph, self.repo, self.revision)

    def test_hidden_path_dependency_is_rejected(self):
        graph = self.graph()
        graph["packages"].append({"id": "hidden", "name": "hidden", "version": "1", "source": None})
        with self.assertRaises(AssertionError):
            verify.check_sources(graph, self.repo, self.revision)

    def test_encoder_must_share_the_actual_core_edge(self):
        graph = self.graph()
        graph["resolve"]["nodes"][1]["deps"] = []
        with self.assertRaises(AssertionError):
            verify.check_sources(graph, self.repo, self.revision)

    def test_recipe_contains_only_matching_git_pins(self):
        manifest = verify.manifest(self.repo, self.revision)
        self.assertNotIn("path =", manifest)
        self.assertNotIn("branch =", manifest)
        self.assertNotIn("[patch.crates-io]", manifest)
        self.assertEqual(manifest.count(f'rev = "{self.revision}"'), 3)


if __name__ == "__main__":
    unittest.main()
