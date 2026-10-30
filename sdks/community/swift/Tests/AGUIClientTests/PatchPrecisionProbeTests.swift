import AGUIClient
import AGUICore
import Foundation
import XCTest

final class PatchPrecisionProbeTests: XCTestCase {
    func testPatchPreservesExistingAndInsertedLargeIntegers() throws {
        let existing = "1234567890123456789012345678901234567891234567890123456789"
        let inserted = "9876543210987654321098765432109876543210987654321098765432"
        let state = Data("{\"existing\":\(existing),\"inserted\":0}".utf8)
        let patch = Data("[{\"op\":\"replace\",\"path\":\"/inserted\",\"value\":\(inserted)}]".utf8)
        let output = try PatchApplicator().apply(patch: patch, to: state)
        let json = String(decoding: output, as: UTF8.self)
        XCTAssertTrue(json.contains(existing), "unchanged state integer was rounded: \(json)")
        XCTAssertTrue(json.contains(inserted), "patch integer was rounded: \(json)")
    }

    func testArrayIndicesMustUseCanonicalDecimalForm() throws {
        let state = Data("{\"items\":[10,20]}".utf8)
        for path in ["/items/01", "/items/+1", "/items/-0"] {
            let patch = Data("[{\"op\":\"replace\",\"path\":\"\(path)\",\"value\":99}]".utf8)
            XCTAssertThrowsError(try PatchApplicator().apply(patch: patch, to: state), path)
        }
    }

    func testNumericallyEquivalentValuesPassTestWithoutPrecisionLoss() throws {
        let huge = "1234567890123456789012345678901234567891234567890123456789"
        let state = Data("{\"n\":1,\"huge\":\(huge)}".utf8)
        let patch = Data("""
        [{"op":"test","path":"/n","value":1.0},
         {"op":"test","path":"/huge","value":\(huge).0},
         {"op":"replace","path":"/n","value":2}]
        """.utf8)
        let result = try PatchApplicator().apply(patch: patch, to: state)
        XCTAssertEqual(try AGUIJSON.parse(result).object?["n"], .number("2"))
        XCTAssertTrue(String(decoding: result, as: UTF8.self).contains(huge))
    }

    func testTestComparesExponentsBeyondMachineIntegerRange() throws {
        let state = Data("{\"large\":1e9223372036854775808,\"small\":1e-9223372036854775808}".utf8)
        let equivalent = Data("""
        [{"op":"test","path":"/large","value":10e9223372036854775807},
         {"op":"test","path":"/small","value":0.1e-9223372036854775807}]
        """.utf8)
        XCTAssertNoThrow(try PatchApplicator().apply(patch: equivalent, to: state))

        let different = Data("[{\"op\":\"test\",\"path\":\"/large\",\"value\":10e9223372036854775808}]".utf8)
        XCTAssertThrowsError(try PatchApplicator().apply(patch: different, to: state))
    }
}
