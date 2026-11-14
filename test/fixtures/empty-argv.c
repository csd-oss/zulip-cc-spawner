#include <sys/prctl.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  for(int i=0;i<argc;i++) memset(argv[i],0,strlen(argv[i]));
  if(prctl(PR_SET_DUMPABLE,0,0,0,0)) return 2;
  printf("ready\n");fflush(stdout);sleep(60);return 0;
}
