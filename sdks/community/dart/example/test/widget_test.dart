// Smoke test: the app boots, the nav rail renders the dojo destinations, and the
// default endpoint (agentic_chat → ClientToolsPage) builds without throwing.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ag_ui_example/main.dart';

void main() {
  testWidgets('app boots and renders the nav rail', (WidgetTester tester) async {
    // A wide surface so the NavigationRail lays out its destinations.
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const MyApp());
    await tester.pump();

    // The shell and a known destination label render.
    expect(find.byType(NavigationRail), findsOneWidget);
    expect(find.text('Agentic Chat'), findsWidgets);
    expect(find.text('Shared State'), findsWidgets);

    // No exception escaped the build of the default page (client-tools).
    expect(tester.takeException(), isNull);
  });
}
