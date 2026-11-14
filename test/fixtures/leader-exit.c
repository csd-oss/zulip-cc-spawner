#include <pthread.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdio.h>
void *worker(void *arg) {
  sleep(1);
  printf("ready tid=%ld\n", syscall(SYS_gettid)); fflush(stdout);
  sleep(60);
  return 0;
}
int main() {
 pthread_t t;
 if (pthread_create(&t,0,worker,0)) return 2;
 pthread_exit(0);
}
