# GameCache

> [!CAUTION]
> **Do not clone this repository to start your own project!**
>
> This repository is fully configured for **my personal collection** and contains user-specific settings (such as `CNAME`, `config.ini`, and static assets) that will break or conflict if you try to host it yourself.
>
> **To create your own board game site:**
> You should use the official template repository. Go to **[EmilStenstrom/gamecache](https://github.com/EmilStenstrom/gamecache)** and click the **"Use this template"** button.

Create a beautiful, searchable website for your BoardGameGeek collection! This project downloads your games from BoardGameGeek, creates a database, and automatically hosts it as a website.

![Site preview](gamecache-preview.png)

## Local Development Setup

Follow these steps to download the code and set up a local environment for development and testing.

### 1. Download the Repository

**Note:** These instructions are for contributing to *this specific repository* or debugging the local setup.

Clone or download this repository to your local machine:

```bash
git clone https://github.com/chardila/mybgg.git
cd mybgg
```

### 2. Set up Python Environment

Prerequisites: Python 3.8 or higher.

It is recommended to use a virtual environment to allow `pip` to manage dependencies safely:

```bash
# Create virtual environment
python3 -m venv venv

# Activate it
# On Linux/macOS:
source venv/bin/activate
# On Windows:
# venv\Scripts\activate
```

### 3. Install Dependencies

Install the required Python packages inside your virtual environment:

```bash
pip install -r scripts/requirements.txt
```

### 4. Configuration

#### Environment Variables (BGG Token)
You need a BoardGameGeek API token to download data. We use a `.env` file to store this securely.

1.  Run the token setup script:
    ```bash
    python scripts/setup_bgg_token.py
    ```
2.  Follow the prompts. This will automatically generate a token and save it to a `.env` file in your project root.
    *   **Note**: The `.env` file contains secrets and is Git-ignored. Do not commit it.
    *   Content format: `GAMECACHE_BGG_TOKEN=your_secret_token`

#### Config File
Update `config.ini` with your details (this file is committed to Git):

```ini
[GameCache]
title = "My Board Game Collection"
bgg_username = <your_bgg_username>
github_repo = <your_github_username>/<repo_name>
```

### 5. Generate Database

Run the download script to fetch data from BGG and generate the local SQLite database (`gamecache.sqlite.gz`).

```bash
# --cache_bgg: Stores downloaded XMLs locally to speed up subsequent runs
# --no_upload: Skips uploading the database to GitHub (useful for local dev)
python scripts/download_and_index.py --cache_bgg --no_upload
```

### 6. Run Locally

Start a simple local web server to view and test your site:

```bash
python -m http.server
```

Open your browser to: [http://localhost:8000](http://localhost:8000)

## Development Workflow

1.  **Modify Code**: Edit `index.html`, `style.css`, or `app-sqlite.js`.
2.  **Test**: Refresh your browser at `localhost:8000` to see changes immediately.
3.  **Update Data**: If you need fresh data from BGG, run the `scripts/download_and_index.py` script again.

## Deployment & Hosting

Once you have your local environment running, you can host your website for free on GitHub Pages.

### 1. Sync with GitHub

If you cloned this repository, you likely already have a `origin` remote. If you are starting fresh or want to push to your own fork:

1.  **Create a new repository** on GitHub (do not start with a README/license).
2.  **Point your local repository** to GitHub:
    ```bash
    # If starting from a fresh folder
    git remote add origin https://github.com/YOUR_GITHUB_USERNAME/REPO_NAME.git
    
    # OR if you already have a remote and need to change it
    git remote set-url origin https://github.com/YOUR_GITHUB_USERNAME/REPO_NAME.git
    
    # Rename master branch to main (optional but recommended by GitHub)
    git branch -M main
    
    # Push your code
    git push -u origin main
    ```

### 2. Configure GitHub Secrets

For the automatic database updates and release management to work, you need to save two tokens in GitHub.

1.  Go to your GitHub repository.
2.  Navigate to **Settings** > **Secrets and variables** > **Actions**.
3.  Click **New repository secret**.
4.  **Add BGG Token**:
    *   **Name**: `GAMECACHE_BGG_TOKEN`
    *   **Secret**: Paste the token value you generated earlier (from your local `.env` file).
5.  **Add GitHub Token** (Required for uploads/releases):
    *   **Name**: `GAMECACHE_GITHUB_TOKEN`
    *   **Secret**: You need a Personal Access Token (Classic) with `repo` scope.
    *   [Generate a new token here](https://github.com/settings/tokens/new) (select `repo` scope).
    *   Paste the token starting with `ghp_...`.

    > **Why is this token required here but not locally?**
    > Locally, the script can run in "interactive mode" and open your browser to authenticate you. In GitHub Actions (the cloud), there is no human to log in, so this token provides the permission to upload files automatically.


### 3. Enable GitHub Pages

To make your website live:

1.  Go to your GitHub repository **Settings**.
2.  Click **Pages** in the left sidebar.
3.  Under **Build and deployment** > **Source**, select **Deploy from a branch**.
4.  Under **Branch**, select `main` (or `master`) and `/ (root)`.
5.  Click **Save**.

Your site will be available shortly at: `https://YOUR_GITHUB_USERNAME.github.io/REPO_NAME/`

## Credits

*   Original Project: [EmilStenstrom/gamecache](https://github.com/EmilStenstrom/gamecache)
*   BoardGameGeek API for game data
