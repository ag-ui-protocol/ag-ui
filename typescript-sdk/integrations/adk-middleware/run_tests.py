#!/usr/bin/env python
"""Test runner for ADK middleware - runs all working tests."""

import subprocess
import sys
from pathlib import Path

# List of all working test files (automated tests only)
TESTS = [
    "test_streaming.py",
    "test_basic.py", 
    "test_integration.py",
    "test_concurrency.py",
    "test_text_events.py",
    "test_session_creation.py",
    "test_chunk_event.py",
    "test_event_bookending.py",
    "test_logging.py",
    "test_credential_service_defaults.py",
    "test_session_cleanup.py",
    "test_session_deletion.py",
    "test_user_id_extractor.py",
    "test_endpoint_error_handling.py"
    # Note: test_server.py is excluded (starts web server, not automated test)
]

def run_test(test_file):
    """Run a single test file and return success status."""
    print(f"\n{'='*60}")
    print(f"🧪 Running {test_file}")
    print('='*60)
    
    try:
        result = subprocess.run([sys.executable, test_file], 
                              capture_output=False, 
                              text=True,
                              timeout=30)
        
        if result.returncode == 0:
            print(f"✅ {test_file} PASSED")
            return True
        else:
            print(f"❌ {test_file} FAILED (exit code {result.returncode})")
            return False
            
    except subprocess.TimeoutExpired:
        print(f"⏰ {test_file} TIMED OUT")
        return False
    except Exception as e:
        print(f"💥 {test_file} ERROR: {e}")
        return False

def main():
    """Run all tests and report results."""
    print("🚀 ADK Middleware Test Suite")
    print("="*60)
    print(f"Running {len(TESTS)} tests...")
    
    passed = 0
    failed = 0
    results = {}
    
    for test_file in TESTS:
        if Path(test_file).exists():
            success = run_test(test_file)
            results[test_file] = success
            if success:
                passed += 1
            else:
                failed += 1
        else:
            print(f"⚠️ {test_file} not found - skipping")
            results[test_file] = None
    
    # Final summary
    print(f"\n{'='*60}")
    print("📊 TEST SUMMARY")
    print('='*60)
    
    for test_file, result in results.items():
        if result is True:
            print(f"✅ {test_file}")
        elif result is False:
            print(f"❌ {test_file}")
        else:
            print(f"⚠️ {test_file} (not found)")
    
    print(f"\n🎯 Results: {passed} passed, {failed} failed")
    
    if failed == 0:
        print("🎉 All tests passed!")
        return 0
    else:
        print(f"⚠️ {failed} test(s) failed")
        return 1

if __name__ == "__main__":
    sys.exit(main())