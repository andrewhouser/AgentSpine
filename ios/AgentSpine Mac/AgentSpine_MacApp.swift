//
//  AgentSpine_MacApp.swift
//  AgentSpine Mac
//
//  Created by Andrew Houser on 11/18/26.
//

import SwiftUI

@main
struct AgentSpine_MacApp: App {
    init() { SpineFont.registerBundled() }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
