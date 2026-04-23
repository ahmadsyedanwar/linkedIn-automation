pipeline {
    agent any

    environment {
        NODE_HOME        = '/usr/local'
        PROJECT_DIR      = '/home/ahmad/linkedin-automation'
        PORT             = '9000'
        // Set LINKEDIN_API_TOKEN and LINKEDIN_WEBHOOK_URL as Jenkins credentials
        LINKEDIN_API_TOKEN   = credentials('LINKEDIN_API_TOKEN')
        LINKEDIN_WEBHOOK_URL = credentials('LINKEDIN_WEBHOOK_URL')
    }

    triggers {
        // Full scrape every 2 hours
        cron('0 */2 * * *')
    }

    stages {

        stage('Checkout') {
            steps {
                dir("${PROJECT_DIR}") {
                    sh 'git pull origin main || true'
                }
            }
        }

        stage('Install Dependencies') {
            steps {
                dir("${PROJECT_DIR}") {
                    sh 'npm ci --prefer-offline || npm install'
                }
            }
        }

        stage('Build') {
            steps {
                dir("${PROJECT_DIR}") {
                    sh 'npm run build'
                }
            }
        }

        stage('Scrape Inbox') {
            steps {
                dir("${PROJECT_DIR}") {
                    sh '''
                        node --import ./register.js src/inbox.ts \
                            2>&1 | tee /tmp/jenkins_inbox_run.log
                    '''
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: '/tmp/linkedin_inbox_*.json', allowEmptyArchive: true
                }
            }
        }

        stage('Check Mentions') {
            steps {
                dir("${PROJECT_DIR}") {
                    sh '''
                        node --import ./register.js src/mentionChecker.ts \
                            2>&1 | tee /tmp/jenkins_mentions_run.log
                    '''
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: '/tmp/linkedin_mentions_*.json', allowEmptyArchive: true
                }
            }
        }

        stage('Analyze & Report') {
            steps {
                dir("${PROJECT_DIR}") {
                    sh '''
                        node --import ./register.js src/inboxCheck.ts --analyze-only \
                            2>&1 | tee /tmp/jenkins_check_run.log
                    '''
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: 'output/linkedin_inbox_check_latest.json', allowEmptyArchive: true
                }
            }
        }

        stage('Ensure API Server Running') {
            steps {
                dir("${PROJECT_DIR}") {
                    sh '''
                        # Check if server is already up on port 9000
                        if curl -sf http://localhost:${PORT}/health > /dev/null 2>&1; then
                            echo "API server already running on port ${PORT}"
                        else
                            echo "Starting API server on port ${PORT}..."
                            # Kill any stale instance
                            pkill -f "src/server.ts" || true
                            pkill -f "dist/server.js" || true
                            sleep 1
                            # Start server in background, log to file
                            nohup node --import ./register.js src/server.ts \
                                > /tmp/linkedin_server.log 2>&1 &
                            echo $! > /tmp/linkedin_server.pid
                            sleep 3
                            # Verify it came up
                            curl -sf http://localhost:${PORT}/health || \
                                (echo "Server failed to start"; cat /tmp/linkedin_server.log; exit 1)
                            echo "API server started (PID $(cat /tmp/linkedin_server.pid))"
                        fi
                    '''
                }
            }
        }

        stage('Notify Webhook') {
            when {
                expression { return env.LINKEDIN_WEBHOOK_URL?.trim() }
            }
            steps {
                sh '''
                    curl -sf http://localhost:${PORT}/webhook/test \
                        -H "Authorization: Bearer ${LINKEDIN_API_TOKEN}" || true
                '''
            }
        }
    }

    post {
        success {
            echo "LinkedIn automation run complete. Results available at http://localhost:${PORT}/needs-reply"
        }
        failure {
            echo "LinkedIn automation run FAILED. Check /tmp/jenkins_*.log for details."
        }
        always {
            // Archive all run logs
            archiveArtifacts artifacts: '/tmp/jenkins_*.log', allowEmptyArchive: true
        }
    }
}
