# AZ Cost Assessment 💸

[![CI](https://github.com/mobieus10036/az-cost-assessment/actions/workflows/ci.yml/badge.svg)](https://github.com/mobieus10036/az-cost-assessment/actions/workflows/ci.yml)
[![CodeQL](https://github.com/mobieus10036/az-cost-assessment/actions/workflows/codeql.yml/badge.svg)](https://github.com/mobieus10036/az-cost-assessment/actions/workflows/codeql.yml)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot)](https://github.com/mobieus10036/az-cost-assessment/security/dependabot)
[![Security Policy](https://img.shields.io/badge/security-policy-blue)](SECURITY.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)

**Your Azure bill jumped. Find out exactly why — in seconds.**

AZ Cost Assessment is a local-first FinOps investigation tool that answers the question every cloud engineer dreads: _"Costs spiked yesterday — which service caused it, and by how much?"_ It attributes daily cost deltas to specific services, detects anomalies, forecasts spend, and surfaces waste — all from your terminal, with no shared infrastructure required.

> Part of the [Mobieus Rapid Assessment Suite](https://github.com/mobieus10036) — Accelerate your Azure security and cost insights.

---

## The Problem It Solves

Azure Cost Management shows you _that_ your costs changed. It doesn't tell you _why_ — not quickly, and not at the right granularity. AZ Cost Assessment runs a targeted investigation: it diffs your daily service-level spend, ranks the drivers behind every significant fluctuation, and produces evidence-first output you can act on immediately.

---

## ✨ Features

### 🎯 Primary: Daily Fluctuation Attribution

The core capability. When costs shift day-over-day, the tool identifies and ranks the exact services that caused the delta:

- Detect significant day-over-day cost changes automatically
- Rank top service-level contributors to each fluctuation
- See previous cost, current cost, and delta side by side
- Output to console, JSON, and shareable HTML report

### 📊 Supporting Cost Intelligence

- **30-day historical analysis** — Full breakdown by service, resource group, and resource
- **Daily cost tracking** — Granular day-by-day view with 14-day rolling window
- **Month-over-month comparison** — Trend analysis across 3 months with projections

### 🔮 Predictive Analytics

- **30-day forecasting** — Trend-based predictions with confidence indicators
- **7-day and 30-day moving averages** — Smooth out noise, see the signal
- **Projected month-end total** — Know your bill before it arrives

### 🚨 Anomaly Detection

- **Z-score statistical analysis** — Surface genuine outliers, not just big numbers
- **Severity classification** — Critical / High / Medium / Low
- **Actionable alerts** — Each anomaly comes with a recommendation

### 💡 Smart Recommendations

- **Orphaned disk detection** — Find unattached storage you're still paying for
- **Stopped VM analysis** — Identify VMs that should be deallocated or deleted
- **Savings projections** — Monthly and annual estimates per recommendation

### 📈 Reporting

- **HTML reports** — Professional, shareable cost analysis documents
- **JSON export** — Feed results into automation pipelines
- **Colorized console output** — Rich terminal display with severity indicators

---

## 🚀 Quickstart

```powershell
git clone https://github.com/mobieus10036/az-cost-assessment.git
cd az-cost-assessment
npm install
npm start
```

On first run, the tool will:

1. ✅ Verify Azure CLI is installed
2. 🔐 Prompt for Azure login if needed
3. 📋 Let you select your subscription interactively
4. 🕒 Ask for your analysis window (`7`, `30`, `90`, or custom days; default `30`)
5. 💾 Optionally save the subscription as your default for future runs
6. 📊 Run the full analysis and generate reports

**See [QUICKSTART.md](QUICKSTART.md) for a detailed walkthrough.**

---

## 📋 Prerequisites

| Requirement | Version | Notes |
| ----------- | ------- | ----- |
| Node.js | ≥ 18.0.0 | LTS recommended |
| npm | ≥ 9.0.0 | Included with Node.js |
| Azure CLI | Latest | [Install guide](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) |
| Azure RBAC | Cost Management Reader + Reader | Minimum roles required |

No Azure Storage account, database, or shared infrastructure needed. Everything runs locally.

---

## 📊 Sample Output

```text
============================================================
AZURE FINOPS ASSESSMENT REPORT
============================================================

📊 COST SUMMARY
------------------------------------------------------------
Historical Total (30 days):     $9,425.98 USD
Current Month to Date:            $972.25 USD
Estimated Month End:            $2,739.99 USD
Average Daily Spend:              $101.94 USD

🎯 DAILY FLUCTUATION ATTRIBUTION
------------------------------------------------------------
⚠️  2026-05-22 → 2026-05-23  (+$312.47, +41.2%)
   #1  Virtual Machines       +$198.30   (+63.4% of delta)
   #2  Azure SQL Database      +$74.15   (+23.7% of delta)
   #3  Storage                 +$40.02   (+12.8% of delta)

💰 TOP EXPENSIVE SERVICES (30 days)
------------------------------------------------------------
1. Virtual Machines              $3,338.83  (35.4%)
2. Storage                       $3,176.35  (33.7%)
3. Microsoft Defender              $895.67   (9.5%)

🚨 ANOMALIES DETECTED
------------------------------------------------------------
[HIGH] Unusual spike in Compute costs (+45% above baseline)

💡 SMART RECOMMENDATIONS
------------------------------------------------------------
Total Recommendations: 5
Potential Monthly Savings:     $450.00 USD
Potential Annual Savings:    $5,400.00 USD
```

---

## 🔧 Configuration

### Environment Variables

`.env` is optional. Without it, the tool uses your active Azure CLI session and prompts interactively at startup — no hardcoded IDs required.

To set a fixed default context, copy `.env.example` to `.env`:

```bash
AZURE_SUBSCRIPTION_ID=your-subscription-id
AZURE_TENANT_ID=your-tenant-id
HISTORICAL_DAYS=30
AZURE_COST_LIVE_DATA_ONLY=true
AZURE_COST_API_DELAY_MS=5000
AZURE_COST_MAX_RETRIES=5
```

### Analysis Settings

Edit `config/default.json` to tune the analysis:

```json
{
  "analysis": {
    "historicalDays": 30,
    "forecastDays": 30,
    "anomalyThresholdPercent": 20,
    "anomalyMinSeverity": "medium"
  }
}
```

### Live Data Integrity

The tool is configured for **live data only** by default. If the Azure Cost Management API fails, analysis stops rather than falling back to synthetic data. Throttling is configurable:

| Variable | Purpose |
| -------- | ------- |
| `AZURE_COST_API_DELAY_MS` | Delay between API calls |
| `AZURE_COST_MAX_RETRIES` | Max retry attempts |
| `AZURE_COST_RETRY_BASE_DELAY_MS` | Base backoff delay |
| `AZURE_COST_RETRY_MAX_DELAY_MS` | Maximum backoff cap |

---

## 🏗️ Architecture

```text
az-cost-assessment/
├── src/
│   ├── app.ts                               # Main entry point
│   ├── analyzers/
│   │   ├── anomalyDetector.ts               # Z-score anomaly detection
│   │   ├── costTrendAnalyzer.ts             # Historical trend analysis
│   │   ├── dailyCostFluctuationAnalyzer.ts  # Primary: fluctuation attribution
│   │   ├── resourceOptimizationAnalyzer.ts  # Waste detection
│   │   ├── smartRecommendationAnalyzer.ts   # Savings recommendations
│   │   └── vmCostAnalyzer.ts               # VM-specific cost analysis
│   ├── services/
│   │   ├── azureCostManagementService.ts    # Azure Cost Management API
│   │   ├── azureResourceService.ts          # Azure Resource Manager API
│   │   └── htmlReportGenerator.ts           # HTML report generation
│   ├── models/                              # TypeScript interfaces
│   └── utils/                               # Config, logging, colors
├── config/                                  # Environment configurations
├── reports/                                 # Generated reports (gitignored)
└── tests/                                   # Unit and integration tests
```

---

## 🔒 Security

- **Never commit `.env`** — it contains your Azure credentials
- **Reports are gitignored** — they contain subscription-specific data
- **Least privilege** — only Cost Management Reader + Reader roles are required
- **Review before sharing** — reports may contain sensitive resource names

See [SECURITY.md](SECURITY.md) for the full security policy.

---

## 📖 Documentation

| Document | Description |
| -------- | ----------- |
| [QUICKSTART.md](QUICKSTART.md) | Get running in under 2 minutes |
| [INSTALL.md](INSTALL.md) | Detailed installation and setup |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guidelines and workflow |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Community standards |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting policy |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) | Release gate process |

---

## 🤝 Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes (`git commit -m 'Add your feature'`)
4. Push to the branch (`git push origin feature/your-feature`)
5. Open a Pull Request

---

## 📝 License

MIT — see [LICENSE](LICENSE) for details.

---

Made by the [Mobieus](https://github.com/mobieus10036) team.
