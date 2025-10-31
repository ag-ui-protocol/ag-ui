# Security Policy

## 🛡️ Our Commitment to Security

The AG-UI-4J project takes security seriously. We appreciate the security research community's efforts in helping us maintain the security of our project and protecting our users.

## 📋 Supported Versions

We provide security updates for the following versions of AG-UI-4J:

| Version | Supported          | Notes                    |
| ------- | ------------------ | ------------------------ |
| 1.0.x   | ✅ Yes             | Current stable release   |
| < 1.0   | ❌ No              | Development versions     |

**Note:** As this project is currently in development (pre-1.0), security updates will be applied to the main branch. Once we reach stable releases, this table will be updated with our long-term support policy.

## 🚨 Reporting Security Vulnerabilities

**Please DO NOT report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, please report security vulnerabilities responsibly through one of these methods:

### Primary Method: GitHub Security Advisories (Recommended)
1. Navigate to the [Security Advisories page](https://github.com/Work-m8/ag-ui-4j/security/advisories)
2. Click "Report a vulnerability"
3. Fill out the vulnerability report form
4. Submit the report

### Alternative Method: Direct Email
If you cannot use GitHub Security Advisories, email us directly:
- **Email:** [pascal.wilbrink@gmail.com](mailto:pascal.wilbrink@gmail.com)
- **Subject:** `[SECURITY] AG-UI-4J Vulnerability Report`

## 📝 What to Include in Your Report

To help us understand and resolve the issue quickly, please include as much of the following information as possible:

### Required Information
- **Description** of the vulnerability
- **Steps to reproduce** the issue
- **Affected versions** of AG-UI-4J
- **Impact assessment** (what an attacker could achieve)

### Additional Helpful Information
- **Proof of concept** code or screenshots
- **Suggested fix** if you have one
- **CVSS score** if you've calculated one
- **Related CVE numbers** if applicable
- **Your preferred contact method** for follow-up

### Example Report Template
```
**Vulnerability Type:** [e.g., SQL Injection, XSS, Authentication Bypass]
**Affected Component:** [e.g., packages/http, packages/client]
**Affected Versions:** [e.g., All versions, 1.0.0-1.0.5]
**Severity:** [e.g., Critical, High, Medium, Low]

**Description:**
[Detailed description of the vulnerability]

**Steps to Reproduce:**
1. [Step 1]
2. [Step 2]
3. [Step 3]

**Impact:**
[What an attacker could achieve]

**Proof of Concept:**
[Code snippet, screenshots, or detailed explanation]

**Suggested Fix:**
[If you have suggestions for fixing the issue]
```

## ⏱️ Response Timeline

We are committed to responding to security reports promptly:

| Timeline | Action |
|----------|--------|
| **Within 24 hours** | Initial acknowledgment of your report |
| **Within 72 hours** | Preliminary assessment and triage |
| **Within 7 days** | Detailed response with our findings |
| **Within 30 days** | Resolution or detailed timeline for complex issues |

## 🔒 Security Update Process

### Our Process
1. **Validation** - We verify and reproduce the reported vulnerability
2. **Assessment** - We assess the impact and assign a severity level
3. **Development** - We develop and test a fix
4. **Review** - Internal security review of the fix
5. **Release** - We release the security update
6. **Disclosure** - We publish details after users have had time to update

### Severity Levels
We use the following severity classification:

- **Critical** - Immediate threat to data integrity or system security
- **High** - Significant security risk that should be addressed quickly
- **Medium** - Moderate security risk with limited impact
- **Low** - Minor security improvement or hardening opportunity

## 📢 Security Announcements

Security updates and announcements will be published through:

- **GitHub Security Advisories** - Primary announcement method
- **GitHub Releases** - Security releases will be clearly marked
- **CHANGELOG.md** - Security fixes will be documented
- **Repository README** - Critical security notices when applicable

## 🛠️ Security Best Practices for Users

### For Developers Using AG-UI-4J

1. **Keep Dependencies Updated**
   ```bash
   mvn dependency:display-plugin-updates
   mvn versions:display-dependency-updates
   ```

2. **Use Dependency Scanning**
   ```bash
   mvn org.owasp:dependency-check-maven:check
   ```

3. **Follow Secure Coding Practices**
   - Validate all inputs
   - Use parameterized queries
   - Implement proper authentication and authorization
   - Handle errors securely (don't expose sensitive information)

4. **Regular Security Audits**
   - Review your application's security posture regularly
   - Keep AG-UI-4J updated to the latest version
   - Monitor security advisories

### For AG-UI-4J Contributors

1. **Code Review Requirements**
   - All code changes require review by at least one maintainer
   - Security-sensitive changes require additional security review

2. **Dependency Management**
   - New dependencies must be justified and reviewed
   - Dependencies should be kept to minimum necessary versions
   - Regular dependency updates via Dependabot

3. **Testing Requirements**
   - Security-related changes require comprehensive tests
   - Include negative test cases (invalid inputs, edge cases)

## 🔍 Known Security Considerations

### Current Security Features
- **Input Validation** - [Describe current validation mechanisms]
- **Authentication** - [Describe authentication methods if applicable]
- **Authorization** - [Describe authorization controls if applicable]
- **Data Protection** - [Describe data protection measures]

### Security Roadmap
As the project evolves, we plan to implement:
- Comprehensive input validation framework
- Security testing automation
- Regular security audits
- Penetration testing for major releases

## 🏆 Security Hall of Fame

We recognize and thank security researchers who have responsibly disclosed vulnerabilities:

<!-- This section will be populated as we receive and resolve security reports -->
*No security reports have been received yet. Be the first to help us improve our security!*

## 📚 Additional Resources

### Security Tools and Standards
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP Java Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Java_Security_Cheat_Sheet.html)
- [CWE (Common Weakness Enumeration)](https://cwe.mitre.org/)
- [CVSS Calculator](https://www.first.org/cvss/calculator/3.1)

### Related Documentation
- [Contributing Guidelines](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Project Documentation](docs/)

## 📞 Contact Information

### Security Team
- **Primary Contact:** Pascal Wilbrink ([pascal.wilbrink@gmail.com](mailto:pascal.wilbrink@gmail.com))
- **GitHub:** [@pascalwilbrink](https://github.com/pascalwilbrink)

### General Questions
For general security questions (not vulnerability reports):
- **GitHub Discussions:** [AG-UI-4J Discussions](https://github.com/Work-m8/ag-ui-4j/discussions)
- **GitHub Issues:** [Create a question issue](https://github.com/Work-m8/ag-ui-4j/issues/new?template=question.yml)

---

**Thank you for helping keep AG-UI-4J and our community safe!** 🙏

*Last updated: August 9 2025*