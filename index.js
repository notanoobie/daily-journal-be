// server.js
import dotenv from 'dotenv';
dotenv.config();
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import pkg from "pg";
import cosineSimilarity from "cosine-similarity";
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

const { Client } = pkg;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});


const MathReasoning = z.object({
  health: z.number(),
  energy: z.number(),
  mental: z.number(),
  charisma: z.number(),
  intellect: z.number(),
  skill: z.number(),
  message: z.string(),
});
const client = new Client({
  user: "postgres",
  host: "database-1.cz42g8gwq283.eu-north-1.rds.amazonaws.com",
  database: "postgres",
  password: "p6AStlYnGWsGJVAyAXZR",
  port: 5432, // default PostgreSQL port
});

client.connect();

const app = express();
const port = 5000;
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Allow specific methods
  allowedHeaders: ['Content-Type', 'Authorization'], // Allow specific headers
}));


app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function numberToWords(number) {
  const words = [
    "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
    "twenty", "twenty one", "twenty two", "twenty three", "twenty four", "twenty five", "twenty six", 
    "twenty seven", "twenty eight", "twenty nine", "thirty", "thirty one"
  ];

  return words[number];
}

// Function to convert Date object to 'Month Day in words' format
function dateToWords(date) {
  const options = { month: 'long' }; // Get full month name
  const month = date.toLocaleString('en-US', options); // 'September'
  const day = date.getDate(); // Get the day number

  return `${month} ${numberToWords(day)}`;
}

// Initialize the OAuth2 client
const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Define the scopes for Google Fit API
const scopes = [
  'https://www.googleapis.com/auth/fitness.activity.read',
  'https://www.googleapis.com/auth/fitness.body.read'
];

app.post("/api/ask", async (req, res) => {
  const question = req.body.entry;
  
  try {
    // Step 1: Generate an embedding for the question
    const questionEmbedding = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: question
    });

    const questionVector = questionEmbedding.data[0].embedding;

    // Step 2: Use a database function to calculate similarity and fetch top entries
    const fetchQuery = `
      WITH similarity_scores AS (
        SELECT 
          journal_entry, 
          date, 
          water, 
          smoke, 
          porn_streak, 
          workout_streak,
          embedding <=> $1::vector AS similarity
        FROM stats
        WHERE embedding IS NOT NULL
      )
      SELECT *
      FROM similarity_scores
      ORDER BY similarity ASC
      LIMIT 10;
    `;
    
    // Convert the questionVector array to a properly formatted PostgreSQL vector string
    const formattedVector = `[${questionVector.join(',')}]`;
    
    const result = await client.query(fetchQuery, [formattedVector]);
    const topEntries = result.rows;

    // Step 3: Prepare the context with the most relevant entries
    const context = topEntries.map(entry => 
      `Date: ${entry.date}, Entry: ${entry.journal_entry}, Water: ${entry.water}, Smoke: ${entry.smoke}, Porn Streak: ${entry.porn_streak}, Workout Streak: ${entry.workout_streak}`
    ).join("\n");

    // Step 4: Prepare the prompt with the context and the user's question
    const prompt = `Context: ${context}\n\nQuestion: ${question}\nAnswer:`;

    // Step 5: Call the OpenAI API to generate an answer based on the relevant entries
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-2024-08-06",
      messages: [
        {
          role: "system",
          content: `You are my personal life coach who helps me become the best version of myself. You have access to my daily journals and other details through the context i provide. The prompt i send you will be in the form of "Context" then "Question". Each answer is to be concise and not more than 2 or 3 lines. Convert any dates in the question into word format like "October four", this has to be only for the question, not the answer you send as a response. Some questions will be vague, in these cases try your best to use the information available from the context as best as possible`,
        },
        { role: "user", content: prompt }
      ]
    });

    // Step 6: Send the response back to the frontend
    res.json({ answer: completion.choices[0].message.content });
  } catch (error) {
    console.error("Error while processing question:", error);
    res.status(500).json({ error: "Internal server error" });
  } 
});


app.post("/api/daily-entry", async (req, res) => {
  const { entry, water, smoke, porn_streak, workout_streak } = req.body;

  try {
    // Validate inputs
    if (typeof water !== 'number' || typeof smoke !== 'number') {
      return res.status(400).json({ error: "Invalid input types" });
    }

    // Fetch the most recent stats
    const result = await client.query(
      "SELECT * FROM stats ORDER BY date DESC LIMIT 1;"
    );

    // Send journal entry to ChatGPT
    const completion = await openai.beta.chat.completions.parse({
      model: "gpt-4o-2024-08-06",
      messages: [
        {
          role: "system",
          content: `You are my personal life coach who helps me become the best version of myself. You are harsh to me when i do things that are not progressing my life and celebrate the things that do. You will be provided a daily journal entry and data about water intake, cigarettes smoked, if i watched porn or not, if i worked out or not which you need to analyse and respond to, along with updating some stats. The stats are health,energy,mental,charisma,intellect,skill. Analyze the given journal entry and current stats and respond with a JSON object for stats between 0-100 skill,intellect,charisma,health,energy,mental. Also include a one-line response in the JSON object parameter message. If the entry is not detailed enough, ask for more information in the message, and return the stats as null. Your tone is one of a friend who is interested in the person's day. But you are also aggressive and want me to improve my stats.`,
          },
          {
            role: "user",
            content: `Previous day's stats:${result.rows[0]} , Cups of water:${water} , Ciggaretes Smoked:${smoke}, Watched porn?:${porn_streak!=0?"No":"Yes"}, Worked out?:${workout_streak!=0?"No":"Yes"}, entry: ${entry}`,
          },
        ],
        response_format: zodResponseFormat(MathReasoning, "math_reasoning"),
      });

    const updated_stats = completion.choices[0].message.parsed;
    updated_stats.image = 1;
    // Determine the image to show based on the stats (for your frontend)
    if (updated_stats.health > 80) {
      updated_stats.image = 2;
    }
    if (updated_stats.energy < 50) {
      updated_stats.image = 3;
    }
    const date = new Date();
    console.log( updated_stats.charisma);
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: `Date:${dateToWords(date)} ${entry}`
    });
  
    const embedding = embeddingResponse.data[0].embedding; 

    
 
   
    // Update the insert query to include all new columns
    const insertQuery = `
      INSERT INTO stats (date, health, energy, mental, charisma, intellect, skill, water, smoke, journal_entry, embedding, porn_streak, workout_streak)
      VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (date) 
      DO UPDATE SET 
        health = EXCLUDED.health,
        energy = EXCLUDED.energy,
        mental = EXCLUDED.mental,
        charisma = EXCLUDED.charisma,
        intellect = EXCLUDED.intellect,
        skill = EXCLUDED.skill,
        water = EXCLUDED.water,
        smoke = EXCLUDED.smoke,
        journal_entry = EXCLUDED.journal_entry,
        embedding = EXCLUDED.embedding,
        porn_streak = EXCLUDED.porn_streak,
        workout_streak = EXCLUDED.workout_streak
      RETURNING *;
    `;
   
    const values = [
      updated_stats.health != 0 ? updated_stats.health : result.rows[0].health,
      updated_stats.energy != 0 ? updated_stats.energy : result.rows[0].energy,
      updated_stats.mental != 0 ? updated_stats.mental : result.rows[0].mental,
      updated_stats.charisma != 0 ? updated_stats.charisma : result.rows[0].charisma,
      updated_stats.intellect != 0 ? updated_stats.intellect : result.rows[0].intellect,
      updated_stats.skill != 0 ? updated_stats.skill : result.rows[0].skill,
      water,
      smoke,
      entry,
      embedding,
      porn_streak,
      workout_streak
    ];
    console.log(values);
    const dbResult = await client.query(insertQuery, values);
    
    // Include all stats in the response
    updated_stats.water = water;
    updated_stats.smoke = smoke;
    updated_stats.porn_streak = porn_streak;
    updated_stats.workout_streak = workout_streak;
    console.log( updated_stats);
    res.status(200).json(updated_stats);

    // Fetch Google Fit data
    let fitData = { steps: 0, calories: 0, distance: 0, activeMinutes: 0 };
    try {
      fitData = await getGoogleFitData();
    } catch (fitError) {
      console.error('Error fetching Google Fit data:', fitError);
      // Continue with the request even if Google Fit data fetch fails
    }
  } catch (error) {
    console.error("Error updating stats:", error);
    res.status(500).send("Server error");
  }
});

// Endpoint to get today's entry
app.get("/api/stats", async (req, res) => {
  try {
    const result = await client.query(
      "SELECT * FROM stats ORDER BY date DESC LIMIT 1;"
    );
    
    if (result.rows.length === 0) {
      // If no entry exists, return default stats
      res.status(200).json({
        health: 99,
        energy: 99,
        mental: 99,
        charisma: 99,
        intellect: 99,
        skill: 99,
        water: 0,
        smoke: 0,
        porn_streak: 0,
        workout_streak: 0,
        image: 1
      });
    } else {
      var image = 1;
      var resultResponse = result.rows[0];
      
      if (resultResponse.health > 80) {
        image = 2;
      }
      if (resultResponse.energy < 50) {
        image = 3;
      }
      resultResponse.image = image;
      
      res.status(200).json(resultResponse);
    }
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).send("Server error");
  }
});

app.get('/auth/google-fit', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
  });
  res.redirect(authUrl);
});

app.get('/auth/google-fit/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    // Store the refresh token in your stats table
    await client.query(`
      INSERT INTO stats (date, google_fit_refresh_token)
      VALUES (CURRENT_DATE, $1)
      ON CONFLICT (date) 
      DO UPDATE SET google_fit_refresh_token = EXCLUDED.google_fit_refresh_token
    `, [tokens.refresh_token]);
    res.send('Google Fit authorization successful');
  } catch (error) {
    console.error('Error during Google Fit authorization:', error);
    res.status(500).send('Authorization failed');
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

async function getGoogleFitData() {
  // Fetch the most recent refresh token from the stats table
  const result = await client.query('SELECT google_fit_refresh_token FROM stats WHERE google_fit_refresh_token IS NOT NULL ORDER BY date DESC LIMIT 1');
  const refreshToken = result.rows[0]?.google_fit_refresh_token;

  if (!refreshToken) {
    throw new Error('Google Fit not authorized');
  }

  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const fitness = google.fitness({ version: 'v1', auth: oauth2Client });

  const now = Date.now();
  const midnight = new Date(now).setHours(0, 0, 0, 0);

  const response = await fitness.users.dataset.aggregate({
    userId: 'me',
    requestBody: {
      aggregateBy: [
        { dataTypeName: 'com.google.step_count.delta' },
        { dataTypeName: 'com.google.calories.expended' },
        { dataTypeName: 'com.google.distance.delta' },
        { dataTypeName: 'com.google.active_minutes' }
      ],
      bucketByTime: { durationMillis: 86400000 }, // 1 day
      startTimeMillis: midnight,
      endTimeMillis: now
    }
  });

  const data = response.data.bucket[0].dataset;
  return {
    steps: data[0].point[0]?.value[0]?.intVal || 0,
    calories: data[1].point[0]?.value[0]?.fpVal || 0,
    distance: data[2].point[0]?.value[0]?.fpVal || 0,
    activeMinutes: data[3].point[0]?.value[0]?.intVal || 0
  };
}
