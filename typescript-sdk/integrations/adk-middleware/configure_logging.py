#!/usr/bin/env python
"""Interactive logging configuration for ADK middleware."""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from src.logging_config import _component_logger, show_logging_help

def main():
    """Interactive logging configuration."""
    print("🔧 ADK Middleware Logging Configuration")
    print("=" * 45)
    
    while True:
        print("\nChoose an option:")
        print("1. Show current logging status")
        print("2. Set component logging level")
        print("3. Enable debug mode for components")
        print("4. Disable all logging (set to ERROR)")
        print("5. Quick configurations")
        print("6. Show help")
        print("0. Exit")
        
        choice = input("\nEnter choice (0-6): ").strip()
        
        if choice == "0":
            print("👋 Goodbye!")
            break
        elif choice == "1":
            _component_logger.show_status()
        elif choice == "2":
            set_component_level()
        elif choice == "3":
            enable_debug_mode()
        elif choice == "4":
            _component_logger.disable_all()
            print("🔇 All logging disabled (ERROR level)")
        elif choice == "5":
            quick_configurations()
        elif choice == "6":
            show_logging_help()
        else:
            print("❌ Invalid choice, please try again")

def set_component_level():
    """Set logging level for a specific component."""
    print("\nAvailable components:")
    components = list(_component_logger.COMPONENTS.keys())
    for i, component in enumerate(components, 1):
        print(f"  {i}. {component}")
    
    try:
        comp_choice = int(input("\nEnter component number: ")) - 1
        if 0 <= comp_choice < len(components):
            component = components[comp_choice]
            
            print("\nAvailable levels: DEBUG, INFO, WARNING, ERROR")
            level = input("Enter level: ").strip().upper()
            
            if level in ['DEBUG', 'INFO', 'WARNING', 'ERROR']:
                _component_logger.set_level(component, level)
            else:
                print("❌ Invalid level")
        else:
            print("❌ Invalid component number")
    except ValueError:
        print("❌ Please enter a valid number")

def enable_debug_mode():
    """Enable debug mode for selected components."""
    print("\nAvailable components:")
    components = list(_component_logger.COMPONENTS.keys())
    for i, component in enumerate(components, 1):
        print(f"  {i}. {component}")
    print(f"  {len(components) + 1}. All components")
    
    try:
        choice = input("\nEnter component numbers (comma-separated) or 'all': ").strip()
        
        if choice.lower() == 'all':
            _component_logger.enable_debug_mode()
        else:
            numbers = [int(x.strip()) - 1 for x in choice.split(',')]
            selected_components = []
            for num in numbers:
                if 0 <= num < len(components):
                    selected_components.append(components[num])
            
            if selected_components:
                _component_logger.enable_debug_mode(selected_components)
            else:
                print("❌ No valid components selected")
    except ValueError:
        print("❌ Please enter valid numbers")

def quick_configurations():
    """Provide quick configuration options."""
    print("\nQuick Configurations:")
    print("1. Streaming debug (event_translator + endpoint)")
    print("2. Quiet mode (only errors)")
    print("3. Development mode (all DEBUG)")
    print("4. Production mode (INFO for main, WARNING for details)")
    
    choice = input("\nEnter choice (1-4): ").strip()
    
    if choice == "1":
        _component_logger.set_level('event_translator', 'DEBUG')
        _component_logger.set_level('endpoint', 'DEBUG')
        print("🔍 Streaming debug enabled")
    elif choice == "2":
        _component_logger.disable_all()
        print("🔇 Quiet mode enabled")
    elif choice == "3":
        _component_logger.enable_debug_mode()
        print("🐛 Development mode enabled")
    elif choice == "4":
        # Production settings
        _component_logger.set_level('adk_agent', 'INFO')
        _component_logger.set_level('event_translator', 'WARNING')
        _component_logger.set_level('endpoint', 'WARNING')
        _component_logger.set_level('raw_response', 'WARNING')
        _component_logger.set_level('llm_response', 'WARNING')
        _component_logger.set_level('session_manager', 'WARNING')
        _component_logger.set_level('agent_registry', 'WARNING')
        print("🏭 Production mode enabled")
    else:
        print("❌ Invalid choice")

if __name__ == "__main__":
    main()