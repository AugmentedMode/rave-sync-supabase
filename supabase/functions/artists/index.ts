// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface Artist {
  id?: number;
  name: string;
  spotify_id?: string | null;
  spotify_url?: string | null;
  followers?: number | null;
  genres?: string[] | null;
  popularity?: number | null;
  image_url?: string | null;
  top_tracks?: string[] | null;
  related_artists?: string[] | null;
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

// Extract artist ID from URL for /artists/:id
function getArtistIdFromUrl(url: URL): string | null {
  const pathParts = url.pathname.split('/');
  
  // Look for "/artists/:id" pattern
  for (let i = 0; i < pathParts.length - 1; i++) {
    if (pathParts[i] === "artists" && i + 1 < pathParts.length) {
      const id = pathParts[i + 1];
      // Make sure it's a valid ID and not another route
      if (id && !isNaN(Number(id))) {
        return id;
      }
    }
  }
  return null;
}

// Handler for POST /artists (createArtist)
async function handleCreateArtist(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const body = await req.json() as Artist;
    const { name, spotify_id, spotify_url, followers, genres, popularity, image_url, top_tracks, related_artists } = body;

    // Validate required fields
    if (!name) {
      return badRequestResponse("Missing required field: name");
    }

    // Insert artist
    const { data, error } = await supabaseClient
      .from("artists")
      .insert([{
        name,
        spotify_id,
        spotify_url,
        followers,
        genres,
        popularity,
        image_url,
        top_tracks,
        related_artists
      }])
      .select()
      .single();

    if (error) {
      console.error("Error creating artist:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true, artist: data }),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in createArtist:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for GET /artists (listArtists)
async function handleListArtists(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    
    // Parse query parameters
    const search = url.searchParams.get('search');
    const page = parseInt(url.searchParams.get('page') || '1');
    const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
    
    // Calculate pagination
    const startRange = (page - 1) * pageSize;
    const endRange = page * pageSize - 1;

    // Start building query
    let query = supabaseClient
      .from("artists")
      .select("*");
      
    // Apply search filter if provided
    if (search) {
      query = query.ilike('name', `%${search}%`);
    }
    
    // Get total count with a separate query
    const countQuery = supabaseClient
      .from("artists")
      .select("id", { count: "exact", head: true });
      
    // Apply the same search filter to count query if provided
    if (search) {
      countQuery.ilike('name', `%${search}%`);
    }
    
    const { count: totalCount, error: countError } = await countQuery;
    
    if (countError) {
      console.error("Error counting artists:", countError);
      return serverErrorResponse(countError.message);
    }
    
    // Apply pagination and ordering
    query = query.range(startRange, endRange).order('name');

    const { data, error } = await query;

    if (error) {
      console.error("Error fetching artists:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({
        artists: data,
        pagination: {
          page,
          pageSize,
          totalCount: totalCount || 0,
          totalPages: totalCount ? Math.ceil(totalCount / pageSize) : 0
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in listArtists:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for GET /artists/:id (getArtist)
async function handleGetArtist(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const artistId = getArtistIdFromUrl(url);
    
    if (!artistId) {
      return badRequestResponse("Missing artist ID");
    }

    const { data, error } = await supabaseClient
      .from("artists")
      .select("*")
      .eq("id", artistId)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return new Response(
          JSON.stringify({ error: "Artist not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      console.error("Error fetching artist:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify(data),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in getArtist:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for PUT /artists/:id (updateArtist)
async function handleUpdateArtist(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const artistId = getArtistIdFromUrl(url);
    
    if (!artistId) {
      return badRequestResponse("Missing artist ID");
    }

    const updates = await req.json() as Partial<Artist>;
    
    // Remove id from updates if present
    if (updates.id) {
      delete updates.id;
    }

    // Verify the artist exists
    const { data: existingArtist, error: checkError } = await supabaseClient
      .from("artists")
      .select("id")
      .eq("id", artistId)
      .single();

    if (checkError) {
      if (checkError.code === "PGRST116") {
        return new Response(
          JSON.stringify({ error: "Artist not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      console.error("Error checking artist:", checkError);
      return serverErrorResponse(checkError.message);
    }

    // Update artist
    const { data, error } = await supabaseClient
      .from("artists")
      .update(updates)
      .eq("id", artistId)
      .select()
      .single();

    if (error) {
      console.error("Error updating artist:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true, artist: data }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in updateArtist:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for DELETE /artists/:id (deleteArtist)
async function handleDeleteArtist(req: Request) {
  try {
    // For deleting artists, require API key since it's a more sensitive operation
    if (!verifyApiKey(req)) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const artistId = getArtistIdFromUrl(url);
    
    if (!artistId) {
      return badRequestResponse("Missing artist ID");
    }

    // Check if artist exists
    const { data: existingArtist, error: checkError } = await supabaseAdminClient
      .from("artists")
      .select("id")
      .eq("id", artistId)
      .single();

    if (checkError) {
      if (checkError.code === "PGRST116") {
        return new Response(
          JSON.stringify({ error: "Artist not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      console.error("Error checking artist:", checkError);
      return serverErrorResponse(checkError.message);
    }

    // Check for dependencies before deletion
    // 1. Check lineups
    const { count: lineupCount, error: lineupError } = await supabaseAdminClient
      .from("lineups")
      .select("*", { count: "exact", head: true })
      .eq("artist_id", artistId);

    if (lineupError) {
      console.error("Error checking lineup dependencies:", lineupError);
      return serverErrorResponse(lineupError.message);
    }

    if (lineupCount && lineupCount > 0) {
      return new Response(
        JSON.stringify({ 
          error: "Cannot delete artist with existing lineup entries",
          dependencies: { lineups: lineupCount }
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Check set_times
    const { count: setTimeCount, error: setTimeError } = await supabaseAdminClient
      .from("set_times")
      .select("*", { count: "exact", head: true })
      .eq("artist_id", artistId);

    if (setTimeError) {
      console.error("Error checking set_time dependencies:", setTimeError);
      return serverErrorResponse(setTimeError.message);
    }

    if (setTimeCount && setTimeCount > 0) {
      return new Response(
        JSON.stringify({ 
          error: "Cannot delete artist with existing set times",
          dependencies: { set_times: setTimeCount }
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Check artist_collaborations
    const { count: collabCount, error: collabError } = await supabaseAdminClient
      .from("artist_collaborations")
      .select("*", { count: "exact", head: true })
      .eq("artist_id", artistId);

    if (collabError) {
      console.error("Error checking collaboration dependencies:", collabError);
      return serverErrorResponse(collabError.message);
    }

    if (collabCount && collabCount > 0) {
      return new Response(
        JSON.stringify({ 
          error: "Cannot delete artist with existing collaborations",
          dependencies: { collaborations: collabCount }
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // Delete artist using admin client
    const { error } = await supabaseAdminClient
      .from("artists")
      .delete()
      .eq("id", artistId);

    if (error) {
      console.error("Error deleting artist:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in deleteArtist:", error);
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

    // Extract artist ID from URL
    const artistId = getArtistIdFromUrl(url);
    
    console.log('artistId', artistId);
    
    // Check URL patterns
    const isArtistsBaseRoute = (path === "/artists" || path === "/artists/");
    const isArtistSpecificRoute = artistId !== null;
    
    console.log('isArtistsBaseRoute', isArtistsBaseRoute);
    console.log('isArtistSpecificRoute', isArtistSpecificRoute);
    console.log('method', method);
    
    // Route requests to appropriate handlers
    if (isArtistsBaseRoute && method === "POST") {
      return await handleCreateArtist(req);
    } else if (isArtistsBaseRoute && method === "GET") {
      return await handleListArtists(req);
    } else if (isArtistSpecificRoute && method === "GET") {
      return await handleGetArtist(req);
    } else if (isArtistSpecificRoute && method === "PUT") {
      return await handleUpdateArtist(req);
    } else if (isArtistSpecificRoute && method === "DELETE") {
      return await handleDeleteArtist(req);
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

  # Create Artist (Authenticated)
  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/artists' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Deadmau5","spotify_id":"2CIMQHirSU0MQqyYHq0eOx","image_url":"https://i.scdn.co/image/ab6761610000e5eb563bca16d311aa7f497167e2","genres":["big room","canadian electronic","edm","electro house","progressive house"]}'

  # List Artists (Authenticated)
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/artists?search=dead&page=1&pageSize=10' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'

  # Get Artist (Authenticated)
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/artists/1' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'

  # Update Artist (Authenticated)
  curl -i --location --request PUT 'http://127.0.0.1:54321/functions/v1/artists/1' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN' \
    --header 'Content-Type: application/json' \
    --data '{"followers":12345678,"popularity":95}'

  # Delete Artist (Admin)
  curl -i --location --request DELETE 'http://127.0.0.1:54321/functions/v1/artists/1' \
    --header 'x-api-key: YOUR_API_KEY'
*/
