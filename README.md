# Data-Sync: Data Synchronization & Automated Backup System

Data-Sync is a robust, production-ready, full-stack data synchronization and automated database backup management system. It is designed to dynamically synchronize remote HTTP API data to local or remote PostgreSQL databases, featuring integrated scheduled task management and real-time monitored PostgreSQL backups with a comprehensive visual dashboard.

---

## 🚀 Core Features

### 1. API Authentication & Token Auto-Renewal
- **Credential Management**: Supports configuration of Client ID, Client Secret, and Token retrieval endpoints.
- **Silent Auto-Refresh**: During sync execution, if an expired or invalid token is detected (matching specific error codes or message patterns), the system automatically calls the token refresh API, updates the local SQLite cache, and retries the sync request—requiring zero manual intervention.

### 2. Flexible Data Source & Table Mapping Configuration
- **Database Schema Introspection**: Connects to target PostgreSQL databases, dynamically listing tables and column definitions (including data types and database comments).
- **Field-to-Column Mapping**: Configures precise mappings between source API JSON fields and target PostgreSQL columns.
- **Dynamic Data Cleaning (Transformers)**: Built-in data transformers include:
  - **Static Value**: Maps a constant value to a target column.
  - **Value Mapping Dictionary**: Translates incoming values using a JSON-configured key-value dictionary (e.g., mapping status codes to display text).
  - **String Operations**: Convert strings to UPPERCASE, lowercase, or trim whitespaces.
  - **Custom JavaScript Script**: Write custom JavaScript function bodies to perform advanced data modifications on the fly.
- **Conflict Resolution (Upsert)**: Employs a primary key (PK) conflict resolution mechanism using PostgreSQL's native `INSERT ... ON CONFLICT (...) DO UPDATE SET ...` command to ensure data is updated incrementally without duplication.

### 3. Robust Data Sync Execution
- **Conditional Queries**: Configures API request filters with support for multiple operators (`eq`, `like`, `gt`, `gte`, `lt`, `lte`, `between`, `in`, `neq`) and logic gates (`and`/`or`).
- **Paginated Bulk Retrieval**: Automatically paginates requests based on total records returned, preventing application crashes from excessively large single-page payloads.
- **Real-Time SSE Progress Streaming**: Sync progress is pushed to the client using Server-Sent Events (SSE), offering real-time updates on total records, success count, error count, and a visual progress bar.
- **Execution Controls & Failure Logs**: Allows running sync jobs to be manually cancelled at any time. Row-level write errors are captured and written to downloadable JSON log files for easy debugging.

### 4. Advanced Task Scheduler
- **Distributed Scheduler**: Built-in SQLite-driven scheduling engine that scans the queue minute-by-minute.
- **Flexible Schedule Types**:
  - `once`: Runs at a designated date and time once.
  - `interval`: Repeats every N minutes, hours, or days.
  - `daily`: Runs every day at a specific time.
  - `weekly`: Runs on selected days of the week at a specific time.
- **Task Types**: Supports both **data synchronization tasks** and **database backup tasks**.

### 5. PostgreSQL Database Backup
- **High-Performance Backup**: Integrates with the official `pg_dump` tool to create plain SQL scripts, custom binary format (`.dump`) files, or both.
- **Real-Time Progress Tracking**: Parses the stderr stream of `pg_dump -v` in real time, calculating the percentage of backed-up tables relative to the database total and showing progress interactively.
- **Lifecycle Management**: Auto-deletes old backups based on a configurable retention period (`keep_days`).
- **One-Click Tool Installation**: Automatically detects and asynchronously installs `postgresql-client` (configures Homebrew `libpq` on macOS; configures PostgreSQL official APT repositories on Linux).

---

## 🛠️ Tech Stack

- **Frontend (Client)**: React + TypeScript + Vite (Single Page Application)
- **Backend (Server)**: Node.js + Koa + TypeScript + SQLite3 (for metadata and execution logs persistence)
- **Target Database**: PostgreSQL (supports SSL/Connection pooling)
- **Process Manager**: PM2 (for clustering and logging)
- **Containerization**: Docker + Docker Compose (Multi-stage builds)

---

## 📂 Project Structure

```text
├── client/                      # Frontend React project
│   ├── src/                     
│   │   ├── pages/               # Dashboard pages (Token, Table Mapping, Sync, Tasks, Backups, etc.)
│   │   ├── components/          # Reusable components
│   │   └── App.tsx              # Main routing and layout
│   └── vite.config.ts           # Vite configuration
├── server/                      # Backend Koa project
│   ├── src/                     
│   │   ├── db/sqlite.ts         # SQLite initialization and metadata CRUD
│   │   ├── routes/config.ts     # System API routes
│   │   ├── services/            
│   │   │   ├── apiService.ts    # Remote API communication & token refresh
│   │   │   ├── syncService.ts   # Core data flow sync and PostgreSQL Upsert
│   │   │   ├── schedulerService.ts # Scheduled task runner
│   │   │   └── backupService.ts  # pg_dump backup runner
│   │   └── index.ts             # Service entry point and static file serving
│   ├── tsconfig.json            # TypeScript configuration
│   └── ecosystem.config.cjs     # PM2 backend standalone config
├── docker-compose.yml           # Docker Compose services definition
├── Dockerfile                   # Multi-stage Docker build file
├── ecosystem.config.cjs         # PM2 global configuration
├── install.sh                   # PM2 one-click install script
├── start.sh                     # Local development startup script
└── package-deploy.sh            # Production compilation and packaging script
```

---

## ⚙️ Quick Start

### Local Development

1. **Clone the repository and navigate into the directory**
   ```bash
   git clone https://github.com/microwin1668/data_sync.git
   cd data_sync
   ```

2. **Install all dependencies (Frontend & Backend)**
   ```bash
   npm run install:all
   ```

3. **Run the services separately**
   - Run the backend API service (default port: `3001`):
     ```bash
     npm run dev:server
     ```
   - Run the frontend development server (default port: `5173`):
     ```bash
     npm run dev:client
     ```

---

### 📦 Production Deployment

Three standard deployment approaches are provided:

#### Method A: Docker Compose (Recommended)
Containerized setup with automated multi-stage compilation. SQLite database and logs are persisted to host directories.
```bash
# Start the containers
docker-compose up -d

# Check running status
docker-compose ps

# Tail runtime logs
docker-compose logs -f
```
Access the application at `http://localhost:3001` (Koa serves the static web assets).

#### Method B: PM2 Deployment
Best suited for Linux servers with Node.js installed.
```bash
# Grant execution permissions
chmod +x install.sh

# Run the installation (installs dependencies and starts via PM2)
./install.sh
```
Useful PM2 commands:
- Status check: `pm2 status`
- Tail logs: `pm2 logs data-sync`
- Restart service: `pm2 restart data-sync`

#### Method C: Offline Package Deployment
For intranet environments with no build tools or external network connections.
1. **Compile and package on your development/CI machine**:
   ```bash
   chmod +x package-deploy.sh
   ./package-deploy.sh
   ```
   This generates a zip file like `data-sync-2026xxxx_xxxx.zip` containing all pre-compiled JS/Vite build assets.
2. **Decompress and launch on the target server**:
   ```bash
   unzip data-sync-xxxxxxxx.zip -d /opt/data-sync
   cd /opt/data-sync/server
   npm install --omit=dev  # Install production dependencies only
   cd /opt/data-sync
   mkdir -p data logs      # Create persistence directories
   pm2 start ecosystem.config.cjs
   ```

---

## 💡 User Guide

1. **API Token Configuration**: Navigate to the `Token Config` page, enter your API Client credentials and endpoints, test, and save.
2. **PostgreSQL Connection**: Under the `Data Sources` module, add your target PostgreSQL database connection details.
3. **Table & Field Mappings**: Choose your API source and target PostgreSQL table. Map API JSON keys to target columns, apply Transformers (e.g., formatting dates or mapping codes), and set the primary key.
4. **Execution**: Click "Sync Now" to start a manual ingestion and view real-time SSE progress.
5. **Scheduler**: Go to `Task Manager` to create tasks to run imports daily, weekly, or on fixed intervals in the background.
6. **Automatic Database Backups**: Set up schedules in `Backup Config` (e.g., daily at 2:00 AM) to automatically run database backups and enforce a retention policy.

---

## 🔒 License

This project is open-source and licensed under the [MIT License](LICENSE).
