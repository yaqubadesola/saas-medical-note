import os
from pathlib import Path
from fastapi import FastAPI, Depends, HTTPException 
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi_clerk_auth import ClerkConfig, ClerkHTTPBearer, HTTPAuthorizationCredentials
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()
app = FastAPI()

# Add CORS middleware (allows frontend to call backend)
# allow_credentials=True is invalid with allow_origins=["*"] per fetch/CORS spec; Bearer auth does not need it.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _env_clean(name: str) -> str:
    """Strip whitespace, UTF-8 BOM, and optional surrounding quotes (common in .env / Docker env-file)."""
    raw = os.getenv(name)
    if raw is None:
        return ""
    s = raw.strip().lstrip("\ufeff")
    if len(s) >= 2 and ((s[0] == s[-1] == '"') or (s[0] == s[-1] == "'")):
        s = s[1:-1].strip()
    return s


def _clerk_config_from_env() -> tuple[ClerkConfig, bool]:
    """Build Clerk JWKS config. Wrong or unreachable JWKS → every protected route returns 403."""
    jwks_url = _env_clean("CLERK_JWKS_URL")
    if not jwks_url:
        raise RuntimeError(
            "CLERK_JWKS_URL is missing or empty. Set it in .env to your Clerk Frontend API JWKS URL, e.g. "
            "https://YOUR-INSTANCE.clerk.accounts.dev/.well-known/jwks.json "
            "(Dashboard → Configure → API Keys → copy Frontend API URL and append /.well-known/jwks.json). "
            "If you use https://api.clerk.com/v1/jwks, set CLERK_SECRET_KEY so the server can fetch keys."
        )
    secret = _env_clean("CLERK_SECRET_KEY")
    jwks_headers = None
    if "api.clerk.com" in jwks_url and secret:
        jwks_headers = {"Authorization": f"Bearer {secret}"}
    leeway = float((os.getenv("CLERK_JWT_LEEWAY") or "60").strip() or "60")
    debug = (os.getenv("CLERK_AUTH_DEBUG") or "").strip().lower() in ("1", "true", "yes")
    return ClerkConfig(
        jwks_url=jwks_url,
        jwks_headers=jwks_headers,
        leeway=leeway,
    ), debug

#use this function to get the clerk guard
def get_clerk_guard():
    cfg, debug = _clerk_config_from_env()
    return ClerkHTTPBearer(cfg, debug_mode=debug)



class Visit(BaseModel):
    patient_name: str
    date_of_visit: str
    notes: str

system_prompt = """
You are provided with notes written by a doctor from a patient's visit.
Your job is to summarize the visit for the doctor and provide an email.
Reply with exactly three sections with the headings:
### Summary of visit for the doctor's records
### Next steps for the doctor
### Draft of email to patient in patient-friendly language
"""

def user_prompt_for(visit: Visit) -> str:
    return f"""Create the summary, next steps and draft email for:
Patient Name: {visit.patient_name}
Date of Visit: {visit.date_of_visit}
Notes:
{visit.notes}"""

@app.get("/debug-env")
def debug_env():
    return {
        "CLERK_JWKS_URL": os.getenv("CLERK_JWKS_URL"),
        "CLERK_SECRET_KEY": "exists" if os.getenv("CLERK_SECRET_KEY") else "missing",
    }

@app.post("/api/consultation")
def consultation_summary(
    visit: Visit,
    creds: HTTPAuthorizationCredentials = Depends(get_clerk_guard()),
):
    #check if the user has a premium subscription with plan premium_subscription
    plan = creds.decoded.get("pla", "")
    print("USER PLAN:", plan)
    allowed_plans = ["premium_subscription", "u:premium_subscription"]

    if plan not in allowed_plans:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "subscription_required",
                "message": "You need an active premium subscription to generate medical notes.",
                "required_plan": "premium_subscription",
                "current_plan": plan
            }
        )
    key = (os.getenv("OPENROUTER_API_KEY") or "").strip()
    if not key:
        raise RuntimeError(
            "OPENROUTER_API_KEY is not set. Add it to a .env file in the project root."
        )
    client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=key,
    )
    
    user_prompt = user_prompt_for(visit)
    prompt = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    
    stream = client.chat.completions.create(
        model="openai/gpt-5.4",
        messages=prompt,
        stream=True,
    )
    
    def event_stream():
        for chunk in stream:
            text = chunk.choices[0].delta.content
            if text:
                lines = text.split("\n")
                for line in lines[:-1]:
                    yield f"data: {line}\n\n"
                    yield "data:  \n"
                yield f"data: {lines[-1]}\n\n"
    
    return StreamingResponse(event_stream(), media_type="text/event-stream")

@app.get("/health")
def health_check():
    """Health check endpoint for AWS App Runner"""
    return {"status": "healthy"}

# Serve static files (our Next.js export) - MUST BE LAST!
static_path = Path("static")
if static_path.exists():
    # Serve index.html for the root path
    @app.get("/")
    async def serve_root():
        return FileResponse(static_path / "index.html")
    
    # Mount static files for all other routes
    app.mount("/", StaticFiles(directory="static", html=True), name="static")