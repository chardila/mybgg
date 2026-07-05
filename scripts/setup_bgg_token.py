"""
BGG Token Setup Script

BGG's XML API v2 requires an `Authorization: Bearer <token>` header on every
request. This script walks you through generating that token manually on
BGG's site, validates it against the real API, and saves it locally.
"""

import sys
from pathlib import Path

# Import our own HTTP client
from gamecache.http_client import make_http_request
from gamecache.config import parse_config_file

BGG_TOKEN_PAGE_URL = "https://boardgamegeek.com/application/189/tokens"


def get_bgg_username_from_config(config_path="config.ini"):
    """
    Get the BGG username from config.ini.

    Args:
        config_path: Path to the config file

    Returns:
        The username string, or None if not found
    """
    print("\n" + "="*70)
    print("🎮 BGG TOKEN GENERATOR")
    print("="*70)
    print()
    print("This script walks you through generating a BGG API token and saves it locally.")
    print()

    try:
        config = parse_config_file(config_path)
        username = config.get('bgg_username')
        
        if not username:
            print(f"❌ Error: 'bgg_username' not found in {config_path}")
            print(f"   Please add your BGG username to the config file:")
            print(f"   bgg_username = YOUR_BGG_USERNAME")
            return None
        
        print(f"📖 Read BGG username from {config_path}: {username}")
        return username
        
    except FileNotFoundError:
        print(f"❌ Error: Config file '{config_path}' not found")
        print(f"   Please create a config.ini file with your BGG username")
        return None
    except Exception as e:
        print(f"❌ Error reading config file: {e}")
        return None


def prompt_for_token(username):
    """
    Ask the user to generate a BGG token manually and paste it in.

    Args:
        username: The BGG username, shown so the user confirms they're
            logged in as the right account before generating the token

    Returns:
        The token string the user pasted, or None if left empty
    """
    print(f"\n1. Log in to BoardGameGeek as '{username}' in your browser.")
    print(f"2. Open: {BGG_TOKEN_PAGE_URL}")
    print(f"3. Generate a new application token.\n")

    token = input("Paste your BGG token here: ").strip()
    if not token:
        print("\n❌ No token entered.")
        return None
    return token


def validate_token(token, username):
    """
    Confirm BGG actually accepts this token before saving it.

    Args:
        token: The token to validate
        username: The BGG username to test the collection endpoint against

    Returns:
        True if BGG accepted the token (or validation was inconclusive),
        False if BGG explicitly rejected it (401)
    """
    print("\n🔎 Validating token against BGG...")
    try:
        make_http_request(
            "https://www.boardgamegeek.com/xmlapi2/collection",
            params={"username": username, "version": 1},
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        print("✅ Token accepted by BGG.")
        return True
    except Exception as e:
        error_msg = str(e)
        if "401" in error_msg or "Unauthorized" in error_msg:
            print("❌ BGG rejected this token (401 Unauthorized).")
            print("   Double-check you copied the full token and are logged in as the right user.")
            return False
        print(f"⚠️  Could not validate token online ({e}). Saving it anyway.")
        return True


def save_token_to_config(token, config_path="config.ini"):
    """
    Save the BGG token to a local environment file (not to config.ini for security).

    Args:
        token: The BGG application token
        config_path: Path to the config file (used to find the project root)
    """
    # Create .env file in the same directory as config.ini
    config_file = Path(config_path)
    project_root = config_file.parent
    env_file = project_root / '.env'

    # Check if .env file exists and if GAMECACHE_BGG_TOKEN is already set
    env_lines = []
    token_exists = False

    if env_file.exists():
        with open(env_file, 'r', encoding='utf-8') as f:
            for line in f:
                stripped = line.strip()
                if stripped.startswith('GAMECACHE_BGG_TOKEN'):
                    env_lines.append(f'GAMECACHE_BGG_TOKEN={token}\n')
                    token_exists = True
                else:
                    env_lines.append(line)

    # If token doesn't exist, add it
    if not token_exists:
        env_lines.append(f'GAMECACHE_BGG_TOKEN={token}\n')

    # Write to .env file
    with open(env_file, 'w', encoding='utf-8') as f:
        f.writelines(env_lines)

    print(f"\n✅ Token saved to {env_file}")
    print(f"\n💡 Your token is stored securely in .env (not committed to git)")
    print(f"   The token will be automatically loaded when you run scripts.")
    return True


def main():
    """Main function to orchestrate the token setup process."""
    print("BGG Token Setup for GameCache")
    print("-" * 70)

    # Get username from config.ini
    username = get_bgg_username_from_config()
    if not username:
        sys.exit(1)

    # Get token (manual generation on BGG's site)
    token = prompt_for_token(username)
    if not token:
        sys.exit(1)

    if not validate_token(token, username):
        sys.exit(1)

    # Save to config
    if not save_token_to_config(token):
        print(f"\n⚠️  Token generated but not saved automatically.")
        print(f"   Please create a .env file with:")
        print(f"   GAMECACHE_BGG_TOKEN={token}")
        sys.exit(1)

    print("\n" + "="*70)
    print("🎉 SUCCESS!")
    print("="*70)
    print()
    print("Your BGG token has been configured successfully.")
    print("You can now use GameCache to download and index BGG data.")
    print()


if __name__ == "__main__":
    main()
