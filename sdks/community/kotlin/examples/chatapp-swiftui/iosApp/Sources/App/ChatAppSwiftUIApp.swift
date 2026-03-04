import SwiftUI
import shared

@main
struct ChatAppSwiftUIApp: App {
    @StateObject private var store = ChatAppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
        }
    }
}
