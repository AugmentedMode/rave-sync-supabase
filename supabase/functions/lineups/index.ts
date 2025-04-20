// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface LineupEntry {
  id?: number;
  event_id: number;
  artist_id: number;
  is_headliner?: boolean;
  tier?: number;
  announcement_date?: string;
}

// Create Supabase client
const supabaseClient = createClient(
  Deno.env.get("SUPABASE_URL") || '',
  Deno.env.get("SUPABASE_ANON_KEY") || ''
);

// Create Supabase admin client using the Service Role Key for admin operations
const supabaseAdminClient = createClient(
  Deno.env.get("SUPABASE_URL") || '',
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ''
);

// Get API key from environment variables
const API_KEY = Deno.env.get("x-api-key");

// Error responses
function unauthorizedResponse() {
  return new Response(
    JSON.stringify({ error: "Unauthorized" }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );
}

function badRequestResponse(message = "Bad request") {
  return new Response(
    JSON.stringify({ error: message }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

function methodNotAllowedResponse() {
  return new Response(
    JSON.stringify({ error: "Method not allowed" }),
    { status: 405, headers: { "Content-Type": "application/json" } }
  );
}

function serverErrorResponse(message = "Internal server error") {
  return new Response(
    JSON.stringify({ error: message }),
    { status: 500, headers: { "Content-Type": "application/json" } }
  );
}

// Verify API key for admin operations
function verifyApiKey(req: Request): boolean {
  const apiKeyHeader = req.headers.get("x-api-key");
  return apiKeyHeader === API_KEY;
}

// Get authenticated user from token
async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return null;
  
  try {
    const { data, error } = await supabaseClient.auth.getUser(token);
    if (error || !data.user) return null;
    
    return data.user;
  } catch (error) {
    console.error("Error authenticating user:", error);
    return null;
  }
}

// Extract eventId from URL for /events/:eventId/lineup or /lineups/:eventId/lineup
function getEventIdFromUrl(url: URL): string | null {
  const pathParts = url.pathname.split('/');
  
  // Look for "events" followed by an ID followed by "lineup" anywhere in the path
  for (let i = 0; i < pathParts.length - 2; i++) {
    if ((pathParts[i] === "events" || pathParts[i] === "lineups") && pathParts[i + 2] === "lineup") {
      return pathParts[i + 1];
    }
  }
  return null;
}

// Extract entryId from URL for /lineups/:entryId
function getLineupEntryIdFromUrl(url: URL): string | null {
  const pathParts = url.pathname.split('/');
  // Look for "lineups" followed by an ID anywhere in the path
  for (let i = 0; i < pathParts.length - 1; i++) {
    if (pathParts[i] === "lineups" && i + 1 < pathParts.length) {
      return pathParts[i + 1];
    }
  }
  return null;
}

// Handler for POST /lineups (addLineupEntry)
async function handleAddLineupEntry(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const body = await req.json() as LineupEntry;
    const { event_id, artist_id, is_headliner, tier, announcement_date } = body;

    // Validate required fields
    if (!event_id || !artist_id) {
      return badRequestResponse("Missing required fields: event_id, artist_id");
    }

    // Verify that the event exists and user has access to it
    const { data: event, error: eventError } = await supabaseClient
      .from("events")
      .select("id")
      .eq("id", event_id)
      .single();

    if (eventError || !event) {
      return new Response(
        JSON.stringify({ error: "Event not found or access denied" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Verify that the artist exists
    const { data: artist, error: artistError } = await supabaseClient
      .from("artists")
      .select("id")
      .eq("id", artist_id)
      .single();

    if (artistError || !artist) {
      return new Response(
        JSON.stringify({ error: "Artist not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Insert lineup entry
    const { data, error } = await supabaseClient
      .from("lineups")
      .insert([{
        event_id,
        artist_id,
        is_headliner,
        tier,
        announcement_date
      }])
      .select()
      .single();

    if (error) {
      // Check if it's a unique constraint violation
      if (error.code === '23505') {
        return new Response(
          JSON.stringify({ error: "This artist is already in the lineup for this event" }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
      
      console.error("Error adding lineup entry:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true, entry: data }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in addLineupEntry:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for GET /events/:eventId/lineup (listLineup)
async function handleListLineup(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const eventId = getEventIdFromUrl(url);
    
    if (!eventId) {
      return badRequestResponse("Missing event ID");
    }

    // Verify that the event exists and user has access to it
    const { data: event, error: eventError } = await supabaseClient
      .from("events")
      .select("id")
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      return new Response(
        JSON.stringify({ error: "Event not found or access denied" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get lineup entries with artist details for the event
    const { data, error } = await supabaseClient
      .from("lineups")
      .select(`
        id,
        event_id,
        artist_id,
        is_headliner,
        tier,
        announcement_date,
        artists:artist_id (
          id,
          name,
          spotify_id,
          image_url
        )
      `)
      .eq("event_id", eventId)
      .order("tier", { ascending: true })
      .order("is_headliner", { ascending: false });

    if (error) {
      console.error("Error fetching lineup:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify(data),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in listLineup:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for DELETE /lineups/:entryId (removeLineupEntry)
async function handleRemoveLineupEntry(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const entryId = getLineupEntryIdFromUrl(url);
    
    if (!entryId) {
      return badRequestResponse("Missing lineup entry ID");
    }

    // Verify that the lineup entry exists
    const { data: entry, error: entryError } = await supabaseClient
      .from("lineups")
      .select("id, event_id")
      .eq("id", entryId)
      .single();

    if (entryError || !entry) {
      return new Response(
        JSON.stringify({ error: "Lineup entry not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Verify user has access to the associated event
    const { data: event, error: eventError } = await supabaseClient
      .from("events")
      .select("id")
      .eq("id", entry.event_id)
      .single();

    if (eventError || !event) {
      return unauthorizedResponse();
    }

    // Delete lineup entry
    const { error } = await supabaseClient
      .from("lineups")
      .delete()
      .eq("id", entryId);

    if (error) {
      console.error("Error removing lineup entry:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in removeLineupEntry:", error);
    return serverErrorResponse(error.message);
  }
}

// Main handler
Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;
    
    console.log(`${method} ${path}`);

    // Extract eventId and entryId directly from the URL
    const eventId = getEventIdFromUrl(url);
    const entryId = getLineupEntryIdFromUrl(url);
    
    console.log('eventId', eventId);
    console.log('entryId', entryId);
    
    // Check URL patterns
    const isEventLineupRoute = path.includes("/lineup") && eventId;
    const isLineupPostRoute = (path === "/lineups" || path === "/lineups/");
    const isLineupEntryRoute = path.includes("/lineups/") && entryId

    console.log('isEventLineupRoute', isEventLineupRoute);
    console.log('isLineupPostRoute', isLineupPostRoute);
    console.log('isLineupEntryRoute', isLineupEntryRoute);

    console.log('method', method);
    console.log('path', path);

    
    // Route requests to appropriate handlers
    if (isLineupPostRoute && method === "POST") {
      return await handleAddLineupEntry(req);
    } else if (isEventLineupRoute && method === "GET") {
      return await handleListLineup(req);
    } else if (isLineupEntryRoute && method === "DELETE") {
      return await handleRemoveLineupEntry(req);
    }

    return methodNotAllowedResponse();
  } catch (error) {
    console.error("Unexpected error in main handler:", error);
    return serverErrorResponse("Internal server error");
  }
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make HTTP requests to test the endpoints:

  # Add Lineup Entry (Authenticated)
  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/lineups' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN' \
    --header 'Content-Type: application/json' \
    --data '{"event_id":1,"artist_id":1,"is_headliner":true,"tier":1}'

  # List Lineup for an Event (Authenticated) - both URL formats work
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/events/1/lineup' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'
  
  # Alternative URL format for listing lineup
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/lineups/1/lineup' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'

  # Remove Lineup Entry (Authenticated)
  curl -i --location --request DELETE 'http://127.0.0.1:54321/functions/v1/lineups/1' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'
*/
