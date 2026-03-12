const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const checkWord = require('check-if-word'); 
const wordList = require('an-array-of-english-words');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const dictionary = checkWord('en'); 

app.use(express.static('public'));

// --- GAME STATE ---
let currentTargetWord = ""; 
let usedWords = [];
let players = []; // Now tracks: { id, username, score, eliminated, hasGenie }
let currentPlayerIndex = 0;
let gameStarted = false;
let lastWinnerId = null; 
let currentRound = 1;

let turnTimerInterval = null;
let timeLeft = 15;
const MAX_TURN_TIME = 15;

let reactionPhaseActive = false;
let pendingWord = "";

const wordPool = {
    base: ["BASKETBALL", "ELEPHANT", "KEYBOARD", "SYMPHONY", "ASTRONAUT", "CAFETARIA", "PINEAPPLE"], 
    long: ["CHAMPIONSHIP", "BATTLEGROUND", "EXTRAORDINARY", "METROPOLITAN", "REVOLUTIONARY"], 
    lowVowel: ["RHYTHMS", "SYZYGY", "GLYPHS", "CRYPTIC", "NYMPHS", "LYNXES"] 
};

function generateWord(round) {
    if (round >= 6) return wordPool.lowVowel[Math.floor(Math.random() * wordPool.lowVowel.length)];
    else if (round >= 3) return wordPool.long[Math.floor(Math.random() * wordPool.long.length)];
    else return wordPool.base[Math.floor(Math.random() * wordPool.base.length)];
}

function isValidDerivation(target, played) {
    if (played === target || played.length > target.length) return false;
    const letterCounts = {};
    for (let char of target) { letterCounts[char] = (letterCounts[char] || 0) + 1; }
    for (let char of played) {
        if (!letterCounts[char]) return false; 
        letterCounts[char]--; 
    }
    return true; 
}

function hasHighestScore(playerId) {
    const player = players.find(p => p.id === playerId);
    const otherScores = players.filter(p => p.id !== playerId).map(p => p.score);
    if (otherScores.length === 0) return true;
    const maxOther = Math.max(...otherScores);
    return player.score > 0 && player.score >= maxOther; 
}

function getGenieWord(target) {
    for (let i = 0; i < wordList.length; i++) {
        let word = wordList[i].toUpperCase();
        if (word.length >= 3 && isValidDerivation(target, word) && !usedWords.includes(word)) {
            return word;
        }
    }
    return null; 
}

function startTurnTimer() {
    clearInterval(turnTimerInterval); 
    timeLeft = MAX_TURN_TIME;         
    io.emit('timer_update', timeLeft); 

    turnTimerInterval = setInterval(() => {
        timeLeft--;
        io.emit('timer_update', timeLeft);

        if (timeLeft <= 0) {
            clearInterval(turnTimerInterval); 
            
            // THE FIX: Check if the player actually exists before eliminating them!
            if (players[currentPlayerIndex]) {
                players[currentPlayerIndex].eliminated = true;
                io.emit('word_rejected', { message: `⏰ Time's up! ${players[currentPlayerIndex].username} is eliminated.` });
                io.emit('roster_update', players);
                nextTurn(); 
            }
        }
    }, 1000); 
}

function triggerReactionPhase(word) {
    clearInterval(turnTimerInterval); 
    pendingWord = word.toUpperCase();
    reactionPhaseActive = false;
    io.emit('prepare_reaction', { round: currentRound });
    
    const delay = Math.floor(Math.random() * 4000) + 2000;
    setTimeout(() => {
        reactionPhaseActive = true;
        io.emit('reaction_go');
    }, delay);
}

function startNewRound(word, startingPlayerId) {
    currentTargetWord = word;
    gameStarted = true;
    usedWords = [];
    
    players.forEach(p => { 
        p.score = 0; 
        p.eliminated = false; 
        p.hasGenie = true; 
    });
    
    currentPlayerIndex = players.findIndex(p => p.id === startingPlayerId);
    
    io.emit('game_started', { targetWord: currentTargetWord, round: currentRound });
    io.emit('roster_update', players);
    io.emit('turn_update', { currentPlayerId: players[currentPlayerIndex].id, username: players[currentPlayerIndex].username });
    
    startTurnTimer(); 
}

function nextTurn() {
    clearInterval(turnTimerInterval); 

    let activePlayers = players.filter(p => !p.eliminated);
    if (activePlayers.length <= 1) {
        gameStarted = false;
        let winner = activePlayers.length === 1 ? activePlayers[0] : null;
        if (winner) lastWinnerId = winner.id; 
        io.emit('game_over', { winner: winner, players: players });
        return;
    }

    do {
        currentPlayerIndex = (currentPlayerIndex + 1) % players.length;
    } while (players[currentPlayerIndex].eliminated);

    io.emit('turn_update', { currentPlayerId: players[currentPlayerIndex].id, username: players[currentPlayerIndex].username });
    startTurnTimer(); 
}

function processWordPlay(socket, word, isGenie = false) {
    let isEliminated = false;
    let errorMessage = "";
    let activePlayer = players[currentPlayerIndex];

    if (!dictionary.check(word.toLowerCase())) {
        isEliminated = true;
        errorMessage = `"${word}" is not a word!`;
    } else if (usedWords.includes(word)) {
        isEliminated = true;
        errorMessage = `"${word}" was already used!`;
    } else if (!isValidDerivation(currentTargetWord, word)) {
        isEliminated = true;
        errorMessage = `"${word}" uses invalid letters!`;
    }

    if (isEliminated) {
        activePlayer.eliminated = true;
        socket.emit('play_result', { success: false, message: `${errorMessage} You are eliminated.` });
        io.emit('word_rejected', { message: `${activePlayer.username} failed on "${word}" and is eliminated.` });
        io.emit('roster_update', players);
        nextTurn();
        return;
    }

    usedWords.push(word);
    activePlayer.score += word.length;
    
    io.emit('roster_update', players);
    let successMessage = isGenie ? `🧞‍♂️ Genie played "${word}" for +${word.length} pts!` : `+${word.length} points!`;
    
    io.emit('word_accepted', { word: word });
    socket.emit('play_result', { success: true, message: successMessage });
    nextTurn();
}

io.on('connection', (socket) => {
    console.log(`🟢 Connection established: ${socket.id}`);
    
    // NEW: Wait for the user to submit their name before adding them to the game
    socket.on('join_lobby', (username) => {
        // Prevent adding the same person twice
        if (!players.find(p => p.id === socket.id)) {
            players.push({ id: socket.id, username: username, score: 0, eliminated: false, hasGenie: true });
            io.emit('roster_update', players);
            socket.emit('join_success'); // Tell their screen to switch views
            console.log(`👤 ${username} joined the lobby.`);
        }
    });

    socket.on('start_game', () => {
        if (players.length >= 2 && !gameStarted) {
            currentRound = 1;
            triggerReactionPhase(generateWord(currentRound));
        }
    });

    socket.on('reaction_clicked', () => {
        if (reactionPhaseActive) {
            reactionPhaseActive = false; 
            startNewRound(pendingWord, socket.id);
        }
    });

    socket.on('set_next_word', (word) => {
        if (socket.id !== lastWinnerId) return; 
        if (word.length < 6) return socket.emit('play_result', { success: false, message: "Word must be at least 6 letters!" });
        if (!dictionary.check(word.toLowerCase())) return socket.emit('play_result', { success: false, message: `"${word}" is not a recognized English word!` });
        currentRound++;
        triggerReactionPhase(word);
    });

    socket.on('auto_next_word', () => {
        if (socket.id !== lastWinnerId) return; 
        currentRound++;
        triggerReactionPhase(generateWord(currentRound));
    });

    socket.on('play_word', (word) => {
        if (!gameStarted) return;
        if (socket.id !== players[currentPlayerIndex].id) return;
        processWordPlay(socket, word, false);
    });

    socket.on('use_genie', () => {
        if (!gameStarted) return;
        if (socket.id !== players[currentPlayerIndex].id) return;
        
        let activePlayer = players[currentPlayerIndex];
        if (!activePlayer.hasGenie) return socket.emit('play_result', { success: false, message: "You already used your Genie this round!" });
        if (!hasHighestScore(activePlayer.id)) return socket.emit('play_result', { success: false, message: "You must have the highest score on the board to use the Genie!" });

        let autoWord = getGenieWord(currentTargetWord);
        if (!autoWord) return socket.emit('play_result', { success: false, message: "The Genie couldn't find any more words! You're on your own!" });

        activePlayer.hasGenie = false;
        io.emit('roster_update', players); 
        processWordPlay(socket, autoWord, true);
    });

    socket.on('disconnect', () => {
        console.log(`🔴 Player disconnected: ${socket.id}`);
        
        // Find exactly where the disconnected player was in the list
        const disconnectedIndex = players.findIndex(p => p.id === socket.id);
        if (disconnectedIndex === -1) return; // Safety escape

        // Remove them from the active roster
        players = players.filter(p => p.id !== socket.id);
        io.emit('roster_update', players);

        // THE FIX: Handle the turn shifting perfectly
        if (gameStarted) {
            if (players.length === 0) {
                // Everyone left! Stop the game and kill the ghost timer.
                gameStarted = false;
                clearInterval(turnTimerInterval);
            } else if (disconnectedIndex === currentPlayerIndex) {
                // The person whose turn it was disconnected. Pass the turn.
                if (currentPlayerIndex >= players.length) {
                    currentPlayerIndex = 0;
                }
                nextTurn();
            } else if (disconnectedIndex < currentPlayerIndex) {
                // Someone BEFORE the active player disconnected. Shift the index back!
                currentPlayerIndex--;
            }
        }
    });
});

// This tells the server: "Use the cloud's port, or use 3000 if I'm testing locally"
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});