# Contributing to AG-UI-4J

Thank you for your interest in contributing to AG-UI-4J! We welcome contributions from the community and are pleased to have you join us.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Documentation](#documentation)
- [Issue Guidelines](#issue-guidelines)
- [Release Process](#release-process)
- [Getting Help](#getting-help)

## Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code. Please report unacceptable behavior to [pascal.wilbrink@gmail.com](mailto:pascal.wilbrink@gmail.com).

## Getting Started

### Prerequisites

- Java 17 or higher (Java 21 LTS recommended)
- Maven 3.8.6 or higher
- Git

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/ag-ui-4j.git
   cd ag-ui-4j
   ```
3. Add the upstream repository:
   ```bash
   git remote add upstream https://github.com/Work-m8/ag-ui-4j.git
   ```

## Development Setup

1. **Build the project:**
   ```bash
   mvn clean compile
   ```

2. **Run tests:**
   ```bash
   mvn test
   ```

3. **Run all checks (including SonarQube if configured locally):**
   ```bash
   mvn clean verify
   ```

### IDE Setup

#### IntelliJ IDEA
- Import the project as a Maven project
- Ensure Project SDK is set to Java 17+
- Enable annotation processing if using any annotation processors

#### Eclipse
- Import as "Existing Maven Projects"
- Ensure Java Build Path uses Java 17+

#### VS Code
- Install the "Extension Pack for Java"
- The project should be automatically recognized as a Maven project

## How to Contribute

### Types of Contributions

We welcome several types of contributions:

- **Bug fixes** - Help us fix issues in the codebase
- **Feature implementations** - Add new functionality
- **Documentation improvements** - Enhance our docs and examples
- **Integration contributions** - Add new integrations (see our integration template)
- **Test improvements** - Increase test coverage and quality
- **Performance optimizations** - Make the code faster and more efficient

### Before You Start

1. **Check existing issues** - Look for existing issues or discussions about your idea
2. **Create an issue** - If one doesn't exist, create an issue to discuss your proposed changes
3. **Get feedback** - Wait for maintainer feedback before starting significant work

## Pull Request Process

### 1. Create a Feature Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/issue-number-description
```

### 2. Make Your Changes

- Follow our [coding standards](#coding-standards)
- Add tests for new functionality
- Update documentation as needed
- Ensure your changes don't break existing functionality

### 3. Commit Your Changes

We follow conventional commits for better automation and changelog generation:

```bash
git commit -m "feat(core): add new agent interaction protocol"
git commit -m "fix(client): resolve connection timeout issue"
git commit -m "docs(readme): update installation instructions"
```

**Commit Types:**
- `feat`: New features
- `fix`: Bug fixes
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks
- `ci`: CI/CD changes

**Scope Examples:**
- `core`: Core functionality
- `client`: Client libraries
- `http`: HTTP utilities
- `spring-http`: Spring HTTP integrations
- `json`: JSON utilities
- `spring-ai`: Spring AI integrations

### 4. Push and Create Pull Request

```bash
git push origin feature/your-feature-name
```

Then create a pull request on GitHub with:
- Clear title following conventional commits
- Detailed description of changes
- Reference to related issues
- Screenshots/examples if applicable

### 5. Pull Request Review

- Maintainers will review your PR
- Address any requested changes
- Keep your branch up to date with main:
  ```bash
  git fetch upstream
  git rebase upstream/main
  ```

## Coding Standards

### Java Coding Style

- **Follow Oracle Java conventions**
- **Use meaningful variable and method names**
- **Write self-documenting code with clear intent**
- **Add JavaDoc for public APIs**

### Code Organization

```java
// Package structure example
com.ag-ui.core.*          // Core functionality
com.ag-ui.client.*        // Client libraries
com.ag-ui.http.*          // HTTP utilities
com.ag-ui.spring.*        // Spring integrations
com.ag-ui.util.*          // Utility classes
```

### Error Handling

- Use appropriate exception types
- Provide meaningful error messages
- Document exceptions in JavaDoc
- Don't catch and ignore exceptions without good reason

### Dependencies

- Minimize external dependencies
- Use well-maintained, popular libraries
- Document any new dependencies in PR description
- Consider the impact on project size and security

## Testing Guidelines

### Test Structure

```
src/test/java/
├── unit/           # Unit tests
├── integration/    # Integration tests
└── performance/    # Performance tests
```

### Writing Tests

- **Write tests for all new functionality**
- **Maintain or improve code coverage**
- **Use descriptive test method names**
- **Follow AAA pattern: Arrange, Act, Assert**

Example:
```java
@Test
void shouldReturnValidResponseWhenValidInputProvided() {
    // Arrange
    AgentClient client = new AgentClient(validConfig);
    Request request = createValidRequest();
    
    // Act
    Response response = client.sendRequest(request);
    
    // Assert
    assertThat(response).isNotNull();
    assertThat(response.isSuccess()).isTrue();
}
```

### Test Categories

- **Unit Tests**: Test individual components in isolation
- **Integration Tests**: Test component interactions
- **Performance Tests**: Validate performance requirements

## Documentation

### Code Documentation

- **Public APIs must have JavaDoc**
- **Include usage examples in JavaDoc**
- **Document complex algorithms or business logic**
- **Keep comments up to date with code changes**

### User Documentation

- Update README.md if your changes affect usage
- Add examples for new features
- Update any relevant documentation in the `docs/` directory

## Issue Guidelines

### Before Creating an Issue

1. **Search existing issues** - Check if the issue already exists
2. **Check documentation** - Ensure it's not already documented
3. **Use appropriate templates** - We have templates for different issue types

### Issue Types

Use our predefined issue templates:
- 🐛 **Bug Report** - Report software bugs
- ✨ **Feature Request** - Suggest new features
- 🔌 **Integration Request** - Request new integrations
- 📚 **Documentation** - Documentation improvements
- ❓ **Question** - Ask questions about the project

### Writing Good Issues

- **Use descriptive titles**
- **Provide detailed descriptions**
- **Include reproduction steps for bugs**
- **Add relevant labels and assignees**
- **Reference related issues or PRs**

## Release Process

### Versioning

We follow [Semantic Versioning](https://semver.org/):
- **MAJOR** version for incompatible API changes
- **MINOR** version for backward-compatible functionality additions
- **PATCH** version for backward-compatible bug fixes

### Release Workflow

1. **Version bump** in `pom.xml`
2. **Update CHANGELOG.md** with release notes
3. **Create release tag** following `v1.0.0` format
4. **GitHub Actions** handles the rest (building, testing, publishing)

## Getting Help

### Communication Channels

- **GitHub Issues** - For bug reports and feature requests
- **GitHub Discussions** - For questions and community discussions
- **Email** - [pascal.wilbrink@gmail.com](mailto:pascal.wilbrink@gmail.com) for direct communication

### Resources

- **Documentation** - Check the `docs/` directory
- **Examples** - Look for example code in the repository
- **Issue Templates** - Use appropriate templates for different types of issues

### Response Times

- **Bug reports**: We aim to respond within 48 hours
- **Feature requests**: We aim to respond within 1 week
- **Pull requests**: We aim to review within 1 week

## Thank You! 🎉

Your contributions make this project better for everyone. We appreciate your time and effort in helping improve AG-UI-4J!

---

*For any questions about contributing, please don't hesitate to reach out through any of our communication channels.*