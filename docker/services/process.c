// The payload never owns supervision. Keep a live kernel parent, an owned
// process group and a subreaper until every descendant has been collected.
// No PID, command or configuration is accepted by a privileged caller here:
// custom use starts after the fixed worker has dropped all privileges.
#define _GNU_SOURCE
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>

static volatile sig_atomic_t stopping = 0;
static void stop(int signal) { (void)signal; stopping = 1; }
static long long millis(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
int main(int argc, char **argv) {
  if (argc < 3 || argv[2][0] != '/') return 100;
  char *end = NULL;
  long grace = strtol(argv[1], &end, 10);
  if (*end || grace < 100 || grace > 30000) return 100;
  struct sigaction action = { .sa_handler = stop };
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);
  pid_t parent = getppid();
  // docker exec can have a parent outside the PID namespace (reported as 0).
  // PDEATHSIG still tracks that kernel parent; no PID-file adoption is used.
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) || prctl(PR_SET_PDEATHSIG, SIGTERM)) return 111;
  if (getppid() != parent) return 111;
  pid_t monitor = getpid();
  pid_t child = fork();
  if (child < 0) return 111;
  if (!child) {
    setpgid(0, 0);
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != monitor) _exit(111);
    execv(argv[2], &argv[2]);
    _exit(errno == ENOENT ? 127 : 126);
  }
  setpgid(child, child);
  int result = 111, main_done = 0, sent = 0, killed = 0;
  long long deadline = 0;
  for (;;) {
    int status;
    pid_t got;
    while ((got = waitpid(-1, &status, WNOHANG)) > 0) {
      if (got == child) {
        main_done = 1;
        result = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      }
    }
    // Subsequent /proc I/O can overwrite errno, including a successful EOF
    // read. Preserve waitpid's terminal result before doing any cleanup I/O.
    int no_children = got < 0 && errno == ECHILD;
    if ((stopping || main_done) && !sent) {
      kill(-child, SIGTERM);
      sent = 1;
      deadline = millis() + grace;
    }
    if (sent && !killed && millis() >= deadline) { kill(-child, SIGKILL); killed = 1; }
    if (sent) {
      // Daemonized descendants are not adopted as services. As subreaper we
      // still collect them on stop/exit, using only our kernel-owned children.
      char file[128];
      snprintf(file, sizeof file, "/proc/self/task/%ld/children", (long)getpid());
      FILE *children = fopen(file, "r");
      if (children) {
        long descendant;
        while (fscanf(children, "%ld", &descendant) == 1)
          if (descendant > 1) kill((pid_t)descendant, killed ? SIGKILL : SIGTERM);
        fclose(children);
      }
    }
    if (no_children) break;
    struct timespec delay = { .tv_nsec = 20000000 };
    nanosleep(&delay, NULL);
  }
  return result;
}
